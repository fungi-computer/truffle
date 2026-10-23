/** An installed extension that owns the compaction handoff slot. */
export default function compactorHost({ defineExtension }) {
  return defineExtension({
    id: "installed-compactor",
    version: "1.0.0",
  }).define({
    compaction: () => ({
      consume: () => ({ type: "discarded_by_policy" }),
    }),
  });
}
