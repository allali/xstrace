FILES=$(wildcard *.c)
BIN=$(FILES:%.c=%.bin)
TRACES=$(FILES:%.c=%.log)

all: $(BIN) $(TRACES)
	echo $(FILES)
	echo $(BIN)
	echo $(TRACES)

clean:
	rm $(BIN) $(TRACES)

%.bin: %.c
	gcc $< -o $@


%.log: %.bin
	strace -f -o $@ ./$<

