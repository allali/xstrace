#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>

int main(){
  int fd;
  char buffer[10]={0};
  write(1,buffer,10);
}
