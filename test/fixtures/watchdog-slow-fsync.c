#define _GNU_SOURCE
#include <dlfcn.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
int fsync(int fd) {
  int (*original)(int) = dlsym(RTLD_NEXT, "fsync");
  char link[64], path[4096];
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, path, sizeof(path)-1);
  if (n > 0) {
    path[n] = 0;
    if (strstr(path, "/watchdog-exit.json")) {
      char marker[8192];
      snprintf(marker, sizeof(marker), "%s.fsync-started", path);
      int observed = open(marker, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
      if (observed >= 0) {
        (void)write(observed, "fsync delayed\n", 14);
        close(observed);
      }
      sleep(6);
    }
  }
  return original(fd);
}
