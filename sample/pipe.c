#include <unistd.h>

int main(){

  int p[2];
  pipe(p);

  close(p[0]);
  close(p[1]);
  
}
