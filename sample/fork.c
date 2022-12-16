#include <sys/types.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>


int main(){
  char buffer[100];
  int fd,e;
  int p[2];
  pipe(p);
  
  if (fork()==0){
    fd=open("in",O_RDONLY);
    close(p[0]);
    while((e=read(fd,buffer,100))>0){
      write(p[1],buffer,e);
    }    
    return 10;
  }
  close(p[1]);
  while((e=read(p[0],buffer,100))>0){
    write(1,buffer,e);
  }
  wait(NULL);
  return 0;
  
}
