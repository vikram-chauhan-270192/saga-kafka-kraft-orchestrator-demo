import express from "express";
import { Kafka } from "kafkajs";
import pkg from "pg";

const { Pool } = pkg;

const PORT = process.env.PORT || 4002;
const KAFKA_BROKER = process.env.KAFKA_BROKER;

const pool = new Pool();

const kafka = new Kafka({
    clientId: "payment-service",
    brokers: [KAFKA_BROKER],
    retry: { retries: 20 },
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: "payment-service-group" });

const app = express();
app.use(express.json());

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS payments (
                                                order_id TEXT PRIMARY KEY,
                                                saga_id TEXT NOT NULL,
                                                amount INT NOT NULL,
                                                status TEXT NOT NULL,
                                                created_at TIMESTAMP DEFAULT NOW()
            );
    `);
}

async function startKafka() {
    await producer.connect();
    await consumer.connect();

    await consumer.subscribe({ topic: "payment.charge.command" });
    await consumer.subscribe({ topic: "payment.refund.command" });

    await consumer.run({
        eachMessage: async ({ topic, message }) => {
            const data = JSON.parse(message.value.toString());

            const sagaId = data.sagaId;
            const orderId = data.orderId;

            if (topic === "payment.charge.command") {
                const amount = data.amount;
                const forceFail = Boolean(data.forceFail);

                const existing = await pool.query(
                    `SELECT * FROM payments WHERE order_id=$1`,
                    [orderId]
                );
                if (existing.rows.length > 0) return;

                // deterministic failure support
                const fail = forceFail ? true : Math.random() < 0.25;

                if (fail) {
                    await pool.query(
                        `INSERT INTO payments(order_id, saga_id, amount, status)
             VALUES($1, $2, $3, $4)`,
                        [orderId, sagaId, amount, "FAILED"]
                    );

                    await producer.send({
                        topic: "payment.failed",
                        messages: [{ value: JSON.stringify({ sagaId, orderId, amount }) }],
                    });

                    return;
                }

                await pool.query(
                    `INSERT INTO payments(order_id, saga_id, amount, status)
                     VALUES($1, $2, $3, $4)`,
                    [orderId, sagaId, amount, "CHARGED"]
                );

                await producer.send({
                    topic: "payment.charged",
                    messages: [{ value: JSON.stringify({ sagaId, orderId, amount }) }],
                });
            }

            if (topic === "payment.refund.command") {
                // refund only if payment exists
                const existing = await pool.query(
                    `SELECT * FROM payments WHERE order_id=$1`,
                    [orderId]
                );
                if (existing.rows.length === 0) return;

                await pool.query(
                    `UPDATE payments SET status='REFUNDED' WHERE order_id=$1`,
                    [orderId]
                );

                await producer.send({
                    topic: "payment.refunded",
                    messages: [{ value: JSON.stringify({ sagaId, orderId }) }],
                });
            }
        },
    });
}

async function main() {
    await initDb();
    startKafka();
    app.listen(PORT, () => console.log("Payment Service running on", PORT));
}

main();
