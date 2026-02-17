import express from "express";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;

const PORT = process.env.PORT || 4001;
const pool = new Pool();

const app = express();
app.use(express.json());

async function initDb() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      total_amount INT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

app.post("/orders", async (req, res) => {
    const { userId, totalAmount } = req.body;
    const orderId = uuidv4();

    await pool.query(
        `INSERT INTO orders(order_id, user_id, total_amount, status)
     VALUES($1, $2, $3, $4)`,
        [orderId, userId, totalAmount, "PENDING"]
    );

    res.status(201).json({ orderId, status: "PENDING" });
});

app.patch("/orders/:orderId/status", async (req, res) => {
    const { orderId } = req.params;
    const { status } = req.body;

    await pool.query(`UPDATE orders SET status=$1 WHERE order_id=$2`, [
        status,
        orderId,
    ]);

    res.json({ orderId, status });
});

app.get("/orders/:orderId", async (req, res) => {
    const { orderId } = req.params;
    const result = await pool.query(`SELECT * FROM orders WHERE order_id=$1`, [
        orderId,
    ]);

    if (result.rows.length === 0) {
        return res.status(404).json({ error: "Order not found" });
    }

    res.json(result.rows[0]);
});

async function main() {
    await initDb();
    app.listen(PORT, () => console.log("Order Service running on", PORT));
}

main();
