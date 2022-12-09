#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>

int main(){
  int fd;
  char buffer[10];
  fd=open("temp",O_WRONLY|O_CREAT,0600);
  write(fd,buffer,10);
}
