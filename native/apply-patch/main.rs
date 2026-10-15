//! Fungi's rooted, bounded host for the pinned upstream Codex patch engine.
use codex_apply_patch::{
    ApplyPatchError, ApplyPatchFileChange, ApplyPatchFileUpdateMode, ApplyPatchOptions, Hunk,
    MaybeApplyPatchVerified, apply_patch_with_options, parse_patch, unified_diff_from_chunks,
    verify_apply_patch_args_with_mode,
};
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use std::cmp::Reverse;
use std::collections::HashSet;
use std::fmt;
use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

const MAX_BYTES: usize = 128 * 1024;
const MAX_FILES: usize = 256;
const MISMATCH_EXIT_CODE: i32 = 23;
const FORMAT_EXIT_CODE: i32 = 24;

fn expected_format(path: &Path) -> String {
    format!(
        "Expected patch format:\n*** Begin Patch\n*** Update File: {}\n@@\n-old line\n+new line\n*** End Patch\nUse @@ alone or @@ followed by an existing context line. Do not use unified-diff line numbers (such as @@ -1 +1 @@), --- or +++ file headers.\n",
        preview(&path.to_string_lossy())
    )
}

#[derive(Debug)]
struct PatchFormatError(String);

impl fmt::Display for PatchFormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}\n{}",
            self.0,
            expected_format(Path::new("path/to/file.txt"))
        )
    }
}

impl std::error::Error for PatchFormatError {}

#[derive(Debug)]
struct PatchMismatch {
    path: PathBuf,
    expected: Vec<String>,
    actual: Vec<(usize, String)>,
}

fn preview(line: &str) -> String {
    let mut chars = line.chars();
    let value: String = chars.by_ref().take(160).collect();
    if chars.next().is_some() {
        format!("{value}…")
    } else {
        value
    }
}

impl fmt::Display for PatchMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(
            f,
            "Patch hunk does not match {}.",
            preview(&self.path.to_string_lossy())
        )?;
        writeln!(f, "Expected hunk:")?;
        for line in self.expected.iter().take(5) {
            writeln!(f, "  {}", preview(line))?;
        }
        if self.expected.len() > 5 {
            writeln!(f, "  … {} more expected lines", self.expected.len() - 5)?;
        }
        writeln!(f, "Closest actual lines:")?;
        for (number, line) in &self.actual {
            writeln!(f, "  {number}: {}", preview(line))?;
        }
        writeln!(
            f,
            "Use the current lines above to correct this hunk and retry."
        )?;
        write!(f, "{}", expected_format(&self.path))
    }
}

impl std::error::Error for PatchMismatch {}

fn shared_edges(expected: &str, actual: &str) -> usize {
    let prefix = expected
        .chars()
        .zip(actual.chars())
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = expected
        .chars()
        .rev()
        .zip(actual.chars().rev())
        .take_while(|(left, right)| left == right)
        .count();
    prefix + suffix
}

async fn first_mismatch(root: &Path, hunks: &[Hunk]) -> Option<PatchMismatch> {
    for hunk in hunks {
        let Hunk::UpdateFile { path, chunks, .. } = hunk else {
            continue;
        };
        let target = admit(root, path).ok()?;
        let source = std::fs::read_to_string(&target).ok()?;
        let uri = PathUri::from_abs_path(&AbsolutePathBuf::try_from(target).ok()?);
        let lines: Vec<&str> = source.lines().collect();
        for (index, chunk) in chunks.iter().enumerate() {
            // Let the engine identify the first failing chunk, including
            // anchors, EOF and ordering. Never duplicate its matching rules.
            if unified_diff_from_chunks(
                &uri,
                &chunks[..=index],
                codex_exec_server::LOCAL_FS.as_ref(),
                None,
            )
            .await
            .is_ok()
            {
                continue;
            }
            let expected = if chunk.old_lines.is_empty() {
                chunk.change_context.iter().cloned().collect()
            } else {
                chunk.old_lines.clone()
            };
            let nearest = (0..lines.len())
                .max_by_key(|&start| {
                    let score = expected
                        .iter()
                        .enumerate()
                        .map(|(offset, old)| {
                            lines
                                .get(start + offset)
                                .map_or(0, |actual| shared_edges(old, actual))
                        })
                        .sum::<usize>();
                    (score, Reverse(start))
                })
                .unwrap_or(0);
            let from = nearest.saturating_sub(2);
            let to = (nearest + expected.len() + 2)
                .min(lines.len())
                .min(from + 7);
            return Some(PatchMismatch {
                path: path.clone(),
                expected,
                actual: (from..to)
                    .map(|index| (index + 1, lines[index].to_owned()))
                    .collect(),
            });
        }
    }
    None
}

fn admit(root: &Path, path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Patch path is outside the invocation root")?;
    if relative.as_os_str().is_empty() {
        return Err("Patch cannot replace the invocation root".into());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => current.push(part),
            Component::CurDir => continue,
            _ => return Err("Patch paths cannot contain parent traversal".into()),
        }
        match std::fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(
                        format!("Patch cannot follow symlinks: {}", current.display()).into(),
                    );
                }
                if !meta.is_dir() && !meta.is_file() {
                    return Err("Patch requires regular files".into());
                }
                #[cfg(unix)]
                if meta.is_file() && meta.nlink() > 1 {
                    return Err(format!(
                        "Patch cannot modify hard-linked file {}. Make a private copy in this folder (copy to a new file, then rename it over this path) and retry; files.edit can replace files under 128 KiB.",
                        current.display()
                    ).into());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(current)
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::fs::canonicalize(std::env::current_dir()?)?;
    let mut patch = String::new();
    io::stdin()
        .take((MAX_BYTES + 1) as u64)
        .read_to_string(&mut patch)?;
    if patch.len() > MAX_BYTES {
        return Err("Patch exceeds the 128 KiB input bound".into());
    }
    let parsed = parse_patch(&patch).map_err(|error| PatchFormatError(error.to_string()))?;
    if parsed.environment_id.is_some() || parsed.workdir.is_some() {
        return Err("Patch cannot select another environment or working directory".into());
    }
    if parsed.hunks.is_empty() || parsed.hunks.len() > MAX_FILES {
        return Err("Patch must affect between 1 and 256 files".into());
    }
    // Verification reads one pre-patch snapshot. Overlapping source/destination
    // paths could otherwise invalidate its result-size checks during application.
    let mut paths = HashSet::new();
    let mut reserve = |path: &Path| -> Result<(), Box<dyn std::error::Error>> {
        if !paths.insert(admit(&root, path)?) {
            return Err("Patch operations have overlapping source or move paths".into());
        }
        Ok(())
    };
    for hunk in &parsed.hunks {
        match hunk {
            Hunk::AddFile { path, .. } | Hunk::DeleteFile { path } => reserve(path)?,
            Hunk::UpdateFile {
                path, move_path, ..
            } => {
                reserve(path)?;
                if let Some(destination) = move_path {
                    reserve(destination)?;
                }
            }
        }
    }
    let cwd = PathUri::from_abs_path(&AbsolutePathBuf::try_from(PathBuf::from(&root))?);
    let mode = ApplyPatchFileUpdateMode::PreserveLineEndings;
    let diagnostic_hunks = parsed.hunks.clone();
    let action = match verify_apply_patch_args_with_mode(
        parsed,
        &cwd,
        mode,
        codex_exec_server::LOCAL_FS.as_ref(),
        None,
    )
    .await
    {
        MaybeApplyPatchVerified::Body(action) => action,
        MaybeApplyPatchVerified::CorrectnessError(ApplyPatchError::ComputeReplacements(error)) => {
            if let Some(mismatch) = first_mismatch(&root, &diagnostic_hunks).await {
                return Err(Box::new(mismatch));
            }
            return Err(format!("Patch verification failed: {error}").into());
        }
        MaybeApplyPatchVerified::CorrectnessError(error) => {
            return Err(format!("Patch verification failed: {error}").into());
        }
        MaybeApplyPatchVerified::ShellParseError(_) => {
            return Err("Patch syntax error".into());
        }
        MaybeApplyPatchVerified::NotApplyPatch => {
            return Err("Patch input was not an apply_patch call".into());
        }
    };
    for change in action.changes().values() {
        let changed_bytes = match change {
            ApplyPatchFileChange::Add { content } | ApplyPatchFileChange::Delete { content } => {
                content.len()
            }
            ApplyPatchFileChange::Update { unified_diff, .. } => unified_diff.len(),
        };
        if changed_bytes > MAX_BYTES {
            return Err("Patch change exceeds the 128 KiB edit bound".into());
        }
    }
    apply_patch_with_options(
        &patch,
        ApplyPatchOptions {
            update_file_mode: mode,
            follow_symlinks: false,
        },
        &cwd,
        &mut io::stdout(),
        &mut io::stderr(),
        codex_exec_server::LOCAL_FS.as_ref(),
        None,
    )
    .await
    .map_err(|failure| {
        let (error, delta) = failure.into_parts();
        format!(
            "{error}; {} file changes already applied (no rollback)",
            delta.changes().len()
        )
    })?;
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(if error.is::<PatchMismatch>() {
            MISMATCH_EXIT_CODE
        } else if error.is::<PatchFormatError>() {
            FORMAT_EXIT_CODE
        } else {
            1
        });
    }
}
