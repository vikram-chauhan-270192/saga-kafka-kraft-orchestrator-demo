import express from "express";
import axios from "axios";
import { Kafka } from "kafkajs";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;

const PORT = process.env.PORT || 4000;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL;
const KAFKA_BROKER = process.env.KAFKA_BROKER;

const pool = new Pool();

const kafka = new Kafka({
    clientId: "saga-orchestrator",
    brokers: [KAFKA_BROKER],
    retry: { retries: 20 },
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "saga-orchestrator-group" });

const app = express();
app.use(express.json());

async function initDb() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS sagas (
      saga_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      status TEXT NOT NULL,
      step TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function waitForEvent(sagaId, allowedTopics, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error("Saga timeout waiting for event"));
        }, timeoutMs);

        const handler = async ({ topic, message }) => {
            const data = JSON.parse(message.value.toString());
            if (data.sagaId !== sagaId) return;
            if (!allowedTopics.includes(topic)) return;

            clearTimeout(timeout);
            consumer.off("consumer.group_join", handler);
            resolve({ topic, data });
        };

        // We cannot attach directly like this in KafkaJS,
        // so we implement event waiting differently:
        // (For simplicity in this demo, we do a polling approach below.)
    });
}

// In this demo, we do a simple approach:
// orchestrator will store saga state and react in consumer.run()

const sagaWaiters = new Map();

function createSagaWaiter(sagaId, expectedTopics, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            sagaWaiters.delete(sagaId);
            reject(new Error("Timeout waiting for saga event"));
        }, timeoutMs);

        sagaWaiters.set(sagaId, { expectedTopics, resolve, reject, timeout });
    });
}

async function startKafka() {
    await producer.connect();
    await consumer.connect();

    await consumer.subscribe({ topic: "payment.charged" });
    await consumer.subscribe({ topic: "payment.failed" });
    await consumer.subscribe({ topic: "payment.refunded" });

    await consumer.subscribe({ topic: "inventory.reserved" });
    await consumer.subscribe({ topic: "inventory.failed" });
    await consumer.subscribe({ topic: "inventory.released" });

    await consumer.run({
        eachMessage: async ({ topic, message }) => {
            const data = JSON.parse(message.value.toString());
            const sagaId = data.sagaId;

            const waiter = sagaWaiters.get(sagaId);
            if (!waiter) return;

            if (!waiter.expectedTopics.includes(topic)) return;

            clearTimeout(waiter.timeout);
            sagaWaiters.delete(sagaId);

            waiter.resolve({ topic, data });
        },
    });
}

app.post("/checkout", async (req, res) => {
    const {
        userId,
        totalAmount,
        forcePaymentFail = false,
        forceInventoryFail = false,
    } = req.body;

    const sagaId = uuidv4();

    // 1) Create order
    const orderResp = await axios.post(`${ORDER_SERVICE_URL}/orders`, {
        userId,
        totalAmount,
    });

    const orderId = orderResp.data.orderId;

    // save saga state
    await pool.query(
        `INSERT INTO sagas(saga_id, order_id, status, step)
         VALUES($1, $2, $3, $4)`,
        [sagaId, orderId, "RUNNING", "ORDER_CREATED"]
    );

    try {
        // 2) Payment charge command
        await producer.send({
            topic: "payment.charge.command",
            messages: [
                {
                    value: JSON.stringify({
                        sagaId,
                        orderId,
                        amount: totalAmount,
                        forceFail: forcePaymentFail,
                    }),
                },
            ],
        });

        const paymentResult = await createSagaWaiter(
            sagaId,
            ["payment.charged", "payment.failed"],
            15000
        );

        if (paymentResult.topic === "payment.failed") {
            await axios.patch(`${ORDER_SERVICE_URL}/orders/${orderId}/status`, {
                status: "CANCELLED",
            });

            await pool.query(
                `UPDATE sagas SET status='FAILED', step='PAYMENT_FAILED' WHERE saga_id=$1`,
                [sagaId]
            );

            return res.status(400).json({
                sagaId,
                orderId,
                status: "FAILED",
                reason: "PAYMENT_FAILED",
            });
        }

        await pool.query(
            `UPDATE sagas SET step='PAYMENT_CHARGED' WHERE saga_id=$1`,
            [sagaId]
        );

        // 3) Inventory reserve command
        await producer.send({
            topic: "inventory.reserve.command",
            messages: [
                {
                    value: JSON.stringify({
                        sagaId,
                        orderId,
                        forceFail: forceInventoryFail,
                    }),
                },
            ],
        });

        const invResult = await createSagaWaiter(
            sagaId,
            ["inventory.reserved", "inventory.failed"],
            15000
        );

        if (invResult.topic === "inventory.failed") {
            await pool.query(
                `UPDATE sagas SET step='INVENTORY_FAILED' WHERE saga_id=$1`,
                [sagaId]
            );

            // compensate: refund payment
            await producer.send({
                topic: "payment.refund.command",
                messages: [{ value: JSON.stringify({ sagaId, orderId }) }],
            });

            await createSagaWaiter(sagaId, ["payment.refunded"], 15000);

            await pool.query(
                `UPDATE sagas SET step='PAYMENT_REFUNDED' WHERE saga_id=$1`,
                [sagaId]
            );

            // cancel order
            await axios.patch(`${ORDER_SERVICE_URL}/orders/${orderId}/status`, {
                status: "CANCELLED",
            });

            await pool.query(
                `UPDATE sagas SET status='FAILED', step='ORDER_CANCELLED' WHERE saga_id=$1`,
                [sagaId]
            );

            return res.status(409).json({
                sagaId,
                orderId,
                status: "FAILED",
                reason: "INVENTORY_FAILED",
            });
        }

        await pool.query(
            `UPDATE sagas SET step='INVENTORY_RESERVED' WHERE saga_id=$1`,
            [sagaId]
        );

        // 4) Confirm order
        await axios.patch(`${ORDER_SERVICE_URL}/orders/${orderId}/status`, {
            status: "CONFIRMED",
        });

        await pool.query(
            `UPDATE sagas SET status='COMPLETED', step='ORDER_CONFIRMED' WHERE saga_id=$1`,
            [sagaId]
        );

        return res.json({
            sagaId,
            orderId,
            status: "COMPLETED",
        });
    } catch (err) {
        console.error("Saga crashed:", err.message);

        await pool.query(
            `UPDATE sagas SET status='FAILED', step='CRASHED' WHERE saga_id=$1`,
            [sagaId]
        );

        return res.status(500).json({
            sagaId,
            orderId,
            status: "FAILED",
            reason: "ORCHESTRATOR_ERROR",
        });
    }
});


async function main() {
    await initDb();
    startKafka();
    app.listen(PORT, () => console.log("Saga Orchestrator running on", PORT));
}

main();
