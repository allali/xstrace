FILES=$(wildcard *.c)
BIN=$(FILES:%.c=%.bin)
TRACES=$(FILES:%.c=%.log)

all: $(BIN) $(TRACES)

clean:
	rm $(BIN) 

%.bin: %.c
	gcc $< -o $@


%.log: %.bin
	strace -f -o $@ ./$< < in q

