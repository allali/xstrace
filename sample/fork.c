#include <sys/types.h>
#include <unistd.h>
#include <sys/wait.h>

int main(){

  if (fork()==0){
    return 10;
  }
  wait(NULL);
  return 0;
  
}
