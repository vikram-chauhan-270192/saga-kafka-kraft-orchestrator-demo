# Saga Pattern (Orchestration) with Kafka (KRaft) + Postgres + Express.js

This repository is a working demo of the **Saga Pattern (Distributed Transactions)** using the **Orchestration** approach.

It runs fully on local Docker containers using:

- Kafka in KRaft mode (no Zookeeper)
- Postgres (one database per microservice)
- Node.js + Express.js microservices
- Docker Compose

This project is designed to be:

- Easy to understand
- Easy to run locally
- Easy to debug using Postgres tables and logs
- Deterministic for testing (you can force failures)

---

## 1) What is a Saga?

A Saga is a pattern for implementing **distributed transactions** in microservices.

In a monolith, you can run a single ACID transaction:

- Create order
- Charge payment
- Reserve inventory
- Confirm order

All in one database transaction.

In microservices:

- each service owns its own database
- there is no safe global ACID transaction across multiple databases

So we use a Saga:

- Each service performs a local transaction
- Services communicate via events/commands
- If a step fails, compensating actions are executed

---

## 2) Orchestration vs Choreography

This repository implements Saga Orchestration.

### Saga Choreography (NOT used here)
- Services emit events
- Other services react
- No central coordinator

### Saga Orchestration (USED here)
- A Saga Orchestrator service controls the entire flow
- It sends commands to services
- Services respond with events
- Orchestrator decides next step and compensations

Orchestration is often preferred in enterprise systems because:
- flow is explicit
- debugging is easier
- compensation logic is centralized

---

## 3) Saga Flow Implemented

The business transaction is:

- Create an order
- Charge payment
- Reserve inventory
- Confirm the order

If any step fails, the orchestrator compensates.

---

### Step-by-step Flow

1. Orchestrator creates Order using Order Service (HTTP)
2. Orchestrator sends Kafka command: payment.charge.command
3. Payment Service replies with:
    - payment.charged OR payment.failed
4. If payment charged:
    - Orchestrator sends inventory.reserve.command
5. Inventory Service replies with:
    - inventory.reserved OR inventory.failed
6. If inventory failed:
    - Orchestrator compensates by sending payment.refund.command
    - Orchestrator cancels the order
7. If inventory reserved:
    - Orchestrator confirms the order

---

## 4) Kafka Topics Used

This repo uses two types of topics:

### A) Command Topics (Orchestrator -> Services)
- payment.charge.command
- payment.refund.command
- inventory.reserve.command
- inventory.release.command (present but not required in basic flow)

### B) Event Topics (Services -> Orchestrator)
- payment.charged
- payment.failed
- payment.refunded
- inventory.reserved
- inventory.failed
- inventory.released (present but not required in basic flow)

---

## 5) Deterministic Testing (Force Failures)

This project supports deterministic failures.

The orchestrator endpoint accepts:

- forcePaymentFail
- forceInventoryFail

Example request:

    POST http://localhost:4000/checkout

Body:

    {
      "userId": "u1",
      "totalAmount": 500,
      "forcePaymentFail": true,
      "forceInventoryFail": false
    }

This guarantees payment fails and order is cancelled.

---

## 6) Project Structure

Repository structure:

    saga-kafka-kraft-orchestrator-demo/
    ├── docker-compose.yml
    ├── README.md
    │
    ├── order-service/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── index.js
    │
    ├── payment-service/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── index.js
    │
    ├── inventory-service/
    │   ├── Dockerfile
    │   ├── package.json
    │   └── index.js
    │
    └── saga-orchestrator/
        ├── Dockerfile
        ├── package.json
        └── index.js

---

## 7) Root File: docker-compose.yml

This is the main file that starts everything.

It starts:

- Kafka broker (KRaft mode)
- kafka-init container (creates topics)
- 4 Postgres databases
- 4 Node.js services

---

### 7.1 Kafka Service (KRaft mode)

The Kafka container is:

- confluentinc/cp-kafka:7.5.3

KRaft mode is enabled using:

- KAFKA_PROCESS_ROLES=broker,controller
- KAFKA_CONTROLLER_QUORUM_VOTERS=1@kafka:9093

This means:
- Kafka runs without Zookeeper
- Kafka metadata is stored internally

---

### 7.2 Why kafka-init exists

Kafka topics must exist before services start.

If services start too early, KafkaJS can crash with errors like:

    KafkaJSProtocolError: This server does not host this topic-partition

To avoid this, kafka-init:

- waits until Kafka is healthy
- creates all required topics
- exits successfully

All services depend on kafka-init.

---

### 7.3 Postgres per microservice

This repository uses one Postgres container per service:

- order-db -> localhost:5433
- payment-db -> localhost:5434
- inventory-db -> localhost:5435
- orchestrator-db -> localhost:5436

This follows the microservices rule:

Each service owns its own database.

---

### 7.4 Microservice Containers

The docker-compose file builds and runs:

- order-service -> localhost:4001
- payment-service -> localhost:4002
- inventory-service -> localhost:4003
- saga-orchestrator -> localhost:4000

---

## 8) Shared Dockerfile (all services)

Each service folder contains a Dockerfile.

The Dockerfile:

- uses Node 20 Alpine
- installs dependencies
- copies the code
- runs npm start

File: service-name/Dockerfile

    FROM node:20-alpine
    WORKDIR /app
    COPY package.json ./
    RUN npm install
    COPY . .
    CMD ["npm", "start"]

Explanation:

- FROM node:20-alpine
  Uses a lightweight Node image.

- WORKDIR /app
  All files are stored inside /app in the container.

- COPY package.json ./
  Copies only package.json first so Docker can cache npm install.

- RUN npm install
  Installs dependencies inside the container.

- COPY . .
  Copies the remaining service source code.

- CMD ["npm", "start"]
  Runs the service.

---

## 9) order-service

The order service is a simple CRUD service for orders.

Important design rule:

Only the order-service owns the orders table.
No other service writes directly to orders.

---

### 9.1 order-service/package.json

This defines dependencies:

- express -> HTTP server
- pg -> Postgres driver
- uuid -> generates unique order IDs

---

### 9.2 order-service/index.js

This file contains:

A) Express server setup  
B) Postgres connection  
C) Table creation  
D) Order API endpoints

---

#### A) Postgres connection

The service uses:

- PGHOST
- PGPORT
- PGUSER
- PGPASSWORD
- PGDATABASE

These are provided by docker-compose.

The code creates a connection pool:

- const pool = new Pool();

---

#### B) Database table created

The order service creates the orders table on startup:

- orders

Columns:

- order_id (primary key)
- user_id
- total_amount
- status
- created_at

---

#### C) HTTP Endpoints

1) POST /orders

Creates an order:

- status = PENDING

2) PATCH /orders/:orderId/status

Updates order status.
Used by orchestrator to set:

- CANCELLED
- CONFIRMED

3) GET /orders/:orderId

Fetches order from DB.
Useful for debugging.

---

#### D) Why Order Service is HTTP-based

In this demo:

- Orchestrator creates orders using HTTP
- This is a common real-world pattern:
    - Orchestrator calls an internal API
    - Then uses Kafka commands for async steps

---

## 10) payment-service

Payment service is event-driven using Kafka.

It listens to commands and emits events.

---

### 10.1 payment-service/package.json

Dependencies:

- kafkajs -> Kafka consumer/producer
- pg -> Postgres
- express -> not required for business logic but included for consistency

---

### 10.2 payment-service/index.js

This file contains:

A) Postgres connection  
B) Kafka consumer and producer  
C) Table creation  
D) Handling payment commands

---

#### A) Database table: payments

Table name:

- payments

Columns:

- order_id (primary key)
- saga_id
- amount
- status
- created_at

Important:

- order_id is PRIMARY KEY
- This provides idempotency

Meaning:

If Kafka delivers the same payment command again,
the service checks if a row already exists for that order_id.

If yes, it ignores the duplicate.

---

#### B) Kafka consumer topics

Payment service subscribes to:

- payment.charge.command
- payment.refund.command

---

#### C) Kafka events emitted

Payment service publishes:

- payment.charged
- payment.failed
- payment.refunded

---

#### D) Deterministic failure logic

The payment.charge.command payload contains:

- forceFail (boolean)

If forceFail is true:
- payment always fails

If forceFail is false:
- payment fails randomly (25% chance)

This allows deterministic testing.

---

#### E) Refund logic

When payment.refund.command is received:

- Payment service updates payments.status = REFUNDED
- Emits payment.refunded

---

## 11) inventory-service

Inventory service is event-driven using Kafka.

It reserves inventory after payment succeeds.

---

### 11.1 inventory-service/package.json

Dependencies:

- kafkajs
- pg
- express (not required but included for consistency)

---

### 11.2 inventory-service/index.js

This file contains:

A) Postgres connection  
B) Kafka consumer and producer  
C) Table creation  
D) Handling inventory commands

---

#### A) Database table: reservations

Table name:

- reservations

Columns:

- order_id (primary key)
- saga_id
- status
- created_at

Important:

- order_id is PRIMARY KEY
- This provides idempotency

---

#### B) Kafka consumer topics

Inventory service subscribes to:

- inventory.reserve.command
- inventory.release.command

---

#### C) Kafka events emitted

Inventory service publishes:

- inventory.reserved
- inventory.failed
- inventory.released

---

#### D) Deterministic failure logic

inventory.reserve.command payload contains:

- forceFail

If true:
- inventory always fails

If false:
- inventory fails randomly (35% chance)

---

## 12) saga-orchestrator

This is the main service that implements the orchestration pattern.

It is responsible for:

- starting the saga
- sending commands
- waiting for events
- applying compensation logic
- updating final order state

---

### 12.1 saga-orchestrator/package.json

Dependencies:

- express -> HTTP API for /checkout
- axios -> call order-service HTTP endpoints
- kafkajs -> Kafka producer/consumer
- pg -> Postgres
- uuid -> generate sagaId

---

### 12.2 saga-orchestrator/index.js

This is the most important file in the repo.

It contains:

A) Express API: POST /checkout  
B) Postgres saga state tracking  
C) Kafka producer for commands  
D) Kafka consumer for events  
E) Saga waiting logic (in-memory waiters)  
F) Compensation logic

---

#### A) sagas table (orchestrator database)

Table name:

- sagas

Columns:

- saga_id (primary key)
- order_id
- status (RUNNING, FAILED, COMPLETED)
- step (string representing current saga step)
- created_at

This table allows you to debug:

- which sagas succeeded
- which sagas failed
- exactly which step failed

---

#### B) POST /checkout endpoint

This endpoint starts the saga.

Request body:

- userId
- totalAmount
- forcePaymentFail (optional)
- forceInventoryFail (optional)

---

#### C) Orchestrator steps

1) Create order (HTTP call to order-service)
2) Insert saga row into sagas table
3) Send payment.charge.command
4) Wait for payment.charged OR payment.failed
5) If payment.failed:
    - cancel order
    - mark saga FAILED
    - return response
6) If payment.charged:
    - send inventory.reserve.command
7) Wait for inventory.reserved OR inventory.failed
8) If inventory.failed:
    - send payment.refund.command
    - wait for payment.refunded
    - cancel order
    - mark saga FAILED
    - return response
9) If inventory.reserved:
    - confirm order
    - mark saga COMPLETED
    - return response

---

#### D) How orchestrator waits for Kafka events

Kafka is asynchronous.

But the HTTP request to /checkout must return a response.

So the orchestrator uses a simple in-memory waiting approach:

- It stores a Promise resolver in a Map keyed by sagaId
- When a Kafka event arrives:
    - it checks sagaId
    - resolves the waiting Promise

This is good for learning.

---

#### E) Important limitation (restart recovery)

Because the waiters are stored in memory:

If the orchestrator container restarts mid-saga:
- the saga will not resume automatically
- the saga will be stuck in RUNNING state

This is expected in this simple version.

Production solutions:

- store saga commands and events in DB
- use outbox/inbox
- use a saga state machine
- use retries and timeouts persisted in DB

---

## 13) How to Run

### 13.1 Clean old containers and volumes

Because the schema changes, it is best to reset:

    docker compose down -v

### 13.2 Start the system

    docker compose up --build

---

## 14) How to Trigger the Saga

Call orchestrator endpoint:

    curl -X POST http://localhost:4000/checkout \
      -H "Content-Type: application/json" \
      -d '{"userId":"u1","totalAmount":500}'

---

## 15) Test Scenarios

### Scenario A: Force payment fail

    curl -X POST http://localhost:4000/checkout \
      -H "Content-Type: application/json" \
      -d '{"userId":"u1","totalAmount":500,"forcePaymentFail":true}'

Expected:

- saga FAILED
- step PAYMENT_FAILED
- order CANCELLED
- payment row exists with status FAILED
- inventory table has 0 rows

---

### Scenario B: Force inventory fail (refund compensation)

    curl -X POST http://localhost:4000/checkout \
      -H "Content-Type: application/json" \
      -d '{"userId":"u1","totalAmount":500,"forceInventoryFail":true}'

Expected:

- payment CHARGED
- inventory FAILED
- payment REFUNDED
- order CANCELLED
- saga FAILED

---

### Scenario C: Success case

    curl -X POST http://localhost:4000/checkout \
      -H "Content-Type: application/json" \
      -d '{"userId":"u1","totalAmount":500,"forcePaymentFail":false,"forceInventoryFail":false}'

Expected:

- saga COMPLETED
- order CONFIRMED
- payment CHARGED
- inventory RESERVED

---

## 16) How to Debug Using Postgres

### 16.1 Order DB

Connect:

    psql -h localhost -p 5433 -U order_user -d order_db

Check orders:

    select * from orders order by created_at desc;

---

### 16.2 Orchestrator DB

Connect:

    psql -h localhost -p 5436 -U orchestrator_user -d orchestrator_db

Check sagas:

    select * from sagas order by created_at desc;

---

### 16.3 Payment DB

Connect:

    psql -h localhost -p 5434 -U payment_user -d payment_db

Check payments:

    select * from payments order by created_at desc;

---

### 16.4 Inventory DB

Connect:

    psql -h localhost -p 5435 -U inventory_user -d inventory_db

Check reservations:

    select * from reservations order by created_at desc;

---

## 17) Production Improvements (Recommended)

This repo is intentionally simple.

To make it production-ready, you should add:

- Outbox pattern for reliable Kafka publishing
- Inbox pattern for reliable command processing
- Retry topics and DLQ topics
- Persist saga events in DB
- Saga restart recovery
- OpenTelemetry tracing
- Schema registry (Avro/Protobuf)

---

## 18) Summary

This repository demonstrates:

- Saga Pattern using Orchestration
- Kafka KRaft mode in Docker
- Postgres per microservice
- Command topics and event topics
- Deterministic testing using forcePaymentFail / forceInventoryFail
- Compensation using refund + cancel order
