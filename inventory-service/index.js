import express from "express";
import { Kafka } from "kafkajs";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 4003;
const KAFKA_BROKER = process.env.KAFKA_BROKER;

const pool = new Pool();

const kafka = new Kafka({
    clientId: "inventory-service",
    brokers: [KAFKA_BROKER],
    retry: { retries: 20 },
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "inventory-service-group" });

const app = express();
app.use(express.json());

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS reservations (
                                                    order_id TEXT PRIMARY KEY,
                                                    saga_id TEXT NOT NULL,
                                                    status TEXT NOT NULL,
                                                    created_at TIMESTAMP DEFAULT NOW()
            );
    `);
}

async function startKafka() {
    await producer.connect();
    await consumer.connect();

    await consumer.subscribe({ topic: "inventory.reserve.command" });
    await consumer.subscribe({ topic: "inventory.release.command" });

    await consumer.run({
        eachMessage: async ({ topic, message }) => {
            const data = JSON.parse(message.value.toString());
            const sagaId = data.sagaId;
            const orderId = data.orderId;

            if (topic === "inventory.reserve.command") {
                const forceFail = Boolean(data.forceFail);

                const existing = await pool.query(
                    `SELECT * FROM reservations WHERE order_id=$1`,
                    [orderId]
                );
                if (existing.rows.length > 0) return;

                const fail = forceFail ? true : Math.random() < 0.35;

                if (fail) {
                    await pool.query(
                        `INSERT INTO reservations(order_id, saga_id, status)
                         VALUES($1, $2, $3)`,
                        [orderId, sagaId, "FAILED"]
                    );

                    await producer.send({
                        topic: "inventory.failed",
                        messages: [{ value: JSON.stringify({ sagaId, orderId }) }],
                    });

                    return;
                }

                await pool.query(
                    `INSERT INTO reservations(order_id, saga_id, status)
                     VALUES($1, $2, $3)`,
                    [orderId, sagaId, "RESERVED"]
                );

                await producer.send({
                    topic: "inventory.reserved",
                    messages: [{ value: JSON.stringify({ sagaId, orderId }) }],
                });
            }

            if (topic === "inventory.release.command") {
                const existing = await pool.query(
                    `SELECT * FROM reservations WHERE order_id=$1`,
                    [orderId]
                );
                if (existing.rows.length === 0) return;

                await pool.query(
                    `UPDATE reservations SET status='RELEASED' WHERE order_id=$1`,
                    [orderId]
                );

                await producer.send({
                    topic: "inventory.released",
                    messages: [{ value: JSON.stringify({ sagaId, orderId }) }],
                });
            }
        },
    });
}

async function main() {
    await initDb();
    startKafka();
    app.listen(PORT, () => console.log("Inventory Service running on", PORT));
}

main();
