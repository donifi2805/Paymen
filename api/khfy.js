const admin = require('firebase-admin');

// Inisialisasi Firebase
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

export default async function handler(req, res) {
    // 1. Validasi Method
    if (req.method !== 'POST') {
        return res.status(405).send({ message: 'Method Not Allowed' });
    }

    const data = req.body;
    console.log("Webhook Khfy Masuk:", JSON.stringify(data));

    // 2. Ambil Data
    const trxId = data.refid || data.ref_id || data.trx_id; 
    const statusPusat = String(data.status || "").toLowerCase();
    const sn = data.sn || "";
    const message = data.message || "";

    if (!trxId) return res.status(400).json({ status: false, msg: "No RefID" });

    try {
        // 3. Cari Transaksi
        const historyQuery = await db.collectionGroup("history")
            .where("trx_id", "==", trxId)
            .limit(1)
            .get();

        if (historyQuery.empty) return res.status(404).json({ status: false, msg: "Trx Not Found" });

        const docSnapshot = historyQuery.docs[0];
        const docRef = docSnapshot.ref;
        const currentData = docSnapshot.data();
        const userRef = docRef.parent.parent;

        if (['Sukses', 'Gagal'].includes(currentData.status)) {
            return res.status(200).json({ status: true, msg: "Already Finalized" });
        }

        // 4. Tentukan Status
        let newStatus = 'Pending';
        let shouldRefund = false;

        if (statusPusat.includes('sukses') || statusPusat.includes('success')) {
            newStatus = 'Sukses';
        } else if (statusPusat.includes('gagal') || statusPusat.includes('failed') || statusPusat.includes('error')) {
            newStatus = 'Gagal';
            shouldRefund = true;
        }

        // 5. Update Database
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw "User Hilang";
            
            let updatePayload = {
                status: newStatus,
                api_msg: sn || message || `Webhook: ${newStatus}`,
                last_updated: admin.firestore.FieldValue.serverTimestamp(),
                raw_json_webhook: JSON.stringify(data)
            };

            if (newStatus === 'Sukses') updatePayload.sn = sn;

            if (shouldRefund) {
                const currentBalance = parseInt(userDoc.data().balance) || 0;
                const refundAmount = parseInt(currentData.amount) || 0;
                t.update(userRef, { balance: currentBalance + refundAmount });
                updatePayload.api_msg = "REFUND: " + (message || "Gagal Pusat");
                updatePayload.balance_final = currentBalance + refundAmount;
            }

            t.update(docRef, updatePayload);
        });

        return res.status(200).json({ status: true, msg: "Update Sukses" });

    } catch (error) {
        console.error("Webhook Error:", error);
        return res.status(500).json({ status: false, error: error.message });
    }
}