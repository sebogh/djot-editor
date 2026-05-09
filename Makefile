.PHONY: all frontend backend run clean

all: backend

frontend:
	cd web && \
	npm install && \
	npm run build

backend: frontend
	go build .

run: frontend
	go run .

clean:
	rm -rf web/dist zorto
