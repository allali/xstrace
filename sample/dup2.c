#include <unistd.h>

int main(){
  dup2(1,3);
}
