#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>

/* what a shell does for: echo hello | wc -c > out.txt */
int main(){
  int p[2];
  pipe(p);
  if (fork()==0){
    dup2(p[1],1);
    close(p[0]);
    close(p[1]);
    execl("/usr/bin/echo","echo","hello",NULL);
    _exit(1);
  }
  if (fork()==0){
    int fd=open("out.txt",O_WRONLY|O_CREAT|O_TRUNC,0644);
    dup2(p[0],0);
    dup2(fd,1);
    close(fd);
    close(p[0]);
    close(p[1]);
    execl("/usr/bin/wc","wc","-c",NULL);
    _exit(1);
  }
  close(p[0]);
  close(p[1]);
  wait(NULL);
  wait(NULL);
  return 0;
}
