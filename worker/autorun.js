const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE & CONFIG ---

// Inisialisasi Firebase
try {
    if (!admin.apps.length) {
        // Gunakan Env Var atau Service Account File
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
} catch (error) {
    console.error("GAGAL SETUP FIREBASE:", error.message);
    process.exit(1);
}

const db = admin.firestore();

// --- 2. KONFIGURASI API (DARI FILE PATOKAN) ---
// Note: Menggunakan native fetch, tidak perlu library tambahan

const API_CONFIG = {
    KHFY: {
        url: "https://panel.khfy-store.com/api_v2/trx",
        key: "8F1199C1-483A-4C96-825E-F5EBD33AC60A" // Sesuaikan jika ada perubahan
    },
    ICS: {
        url: "https://api.ics-store.my.id/api/reseller", // Endpoint ICS
        key: "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77" // Sesuaikan jika ada perubahan
    },
    TELEGRAM: {
        token: "7850521841:AAH84wtuxnDWg5u...", // Token Bot Anda (Lengkapi jika terpotong)
        chatId: "6369628859" // ID Admin Anda
    }
};

// --- 3. HELPER FUNCTIONS (NATIVE FETCH) ---

// Kirim Log ke Telegram
async function sendTelegramLog(msg) {
    if (!API_CONFIG.TELEGRAM.token || !API_CONFIG.TELEGRAM.chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${API_CONFIG.TELEGRAM.token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: API_CONFIG.TELEGRAM.chatId,
                text: msg,
                parse_mode: 'HTML'
            })
        });
    } catch (e) {
        console.error("Telegram Error:", e.message);
    }
}

// Request ke KHFY
async function processKHFY(code, target, refId) {
    try {
        const params = new URLSearchParams();
        params.append('api_key', API_CONFIG.KHFY.key);
        params.append('kode_produk', code);
        params.append('no_hp', target);
        params.append('ref_id', refId);

        const res = await fetch(API_CONFIG.KHFY.url, {
            method: 'POST',
            body: params
        });
        
        const rawText = await res.text();
        try {
            const json = JSON.parse(rawText);
            // KHFY: status 1 = sukses, 0 = pending/proses, else = gagal
            const isSuccess = json.data && (json.data.status === 1 || json.data.status === 0);
            return { 
                success: isSuccess, 
                msg: isSuccess ? (json.data.message || 'Diproses') : (json.message || 'Gagal'),
                sn: isSuccess ? (json.data.sn || '') : '',
                raw: json
            };
        } catch {
            return { success: false, msg: 'Invalid JSON from KHFY', raw: rawText };
        }
    } catch (e) {
        return { success: false, msg: e.message, raw: null };
    }
}

// Request ke ICS
async function processICS(code, target, refId) {
    try {
        const payload = {
            apikey: API_CONFIG.ICS.key,
            service: code,
            target: target,
            custom_ref_id: refId
        };

        const res = await fetch(`${API_CONFIG.ICS.url}?action=order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const rawText = await res.text();
        try {
            const json = JSON.parse(rawText);
            // ICS: result true/false
            const isSuccess = json.success === true || json.status === true;
            return { 
                success: isSuccess, 
                msg: json.msg || json.message || 'Diproses ICS',
                sn: json.data ? json.data.sn : '',
                raw: json
            };
        } catch {
            return { success: false, msg: 'Invalid JSON from ICS', raw: rawText };
        }
    } catch (e) {
        return { success: false, msg: e.message, raw: null };
    }
}

// --- 4. CORE WORKER LOGIC ---

async function runWorker() {
    console.log(`[${new Date().toLocaleTimeString()}] Checking Queue...`);

    try {
        // 1. QUERY: Ambil data PENDING atau GAGAL (Looping Retry)
        // Order by timestamp ASC agar antrian lama diproses duluan
        const snapshot = await db.collection('preorders')
            .where('status', 'in', ['Pending', 'Gagal']) 
            .orderBy('timestamp', 'asc') 
            .limit(1) // Proses 1 per 1 agar aman
            .get();

        if (snapshot.empty) {
            console.log("Antrian Kosong / Semua Sukses.");
            return;
        }

        const doc = snapshot.docs[0];
        const data = doc.data();
        const docId = doc.id;

        // Cek apakah data ini baru saja dicoba (Debounce 10 detik agar tidak spamming jika gagal)
        if (data.lastTry) {
            const lastTryTime = data.lastTry.toDate().getTime();
            if (Date.now() - lastTryTime < 10000) {
                console.log("Cooldown retry...");
                return;
            }
        }

        console.log(`>>> Memproses: ${data.targetNumber} | ${data.productName}`);

        // 2. LOCK: Ubah status jadi 'Proses'
        await db.collection('preorders').doc(docId).update({ status: 'Proses' });

        // Generate Reff ID Unik untuk Server
        const serverRefID = `AUTORUN-${docId}-${Date.now()}`;
        const serverType = (data.serverType || 'KHFY').toUpperCase();

        // 3. EKSEKUSI
        let result;
        if (serverType === 'ICS') {
            result = await processICS(data.provider, data.targetNumber, serverRefID);
        } else {
            result = await processKHFY(data.provider, data.targetNumber, serverRefID);
        }

        // 4. HANDLING HASIL
        if (result.success) {
            // === SUKSES ===
            console.log("✅ SUKSES:", result.msg);

            // Update Preorder (JANGAN HAPUS -> Simpan JSON)
            await db.collection('preorders').doc(docId).update({
                status: 'Success', // Keluar dari loop query
                api_msg: result.msg,
                sn: result.sn,
                raw_json: JSON.stringify(result.raw),
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                trx_id_server: serverRefID
            });

            // Update History User
            if (data.uid && data.historyId) {
                await db.collection('users').doc(data.uid)
                    .collection('history').doc(data.historyId)
                    .update({
                        status: 'Sukses',
                        sn: result.sn || 'Proses Operator',
                        api_msg: `Autorun: ${result.msg}`,
                        trx_id: serverRefID
                    });
            }

            // Notif Telegram
            sendTelegramLog(
                `✅ <b>SUKSES (AUTORUN)</b>\nTarget: ${data.targetNumber}\nProduk: ${data.productName}\nSN: ${result.sn}\nMsg: ${result.msg}`
            );

        } else {
            // === GAGAL (RETRY) ===
            console.log("❌ GAGAL:", result.msg);

            // Kembalikan ke status 'Gagal' agar diambil lagi oleh Query di putaran depan
            await db.collection('preorders').doc(docId).update({
                status: 'Gagal', 
                api_msg: result.msg,
                raw_json: JSON.stringify(result.raw),
                lastTry: admin.firestore.FieldValue.serverTimestamp() // Timestamp untuk cooldown
            });

            // Update History User (Info Gagal Sementara)
            if (data.uid && data.historyId) {
                await db.collection('users').doc(data.uid)
                    .collection('history').doc(data.historyId)
                    .update({
                        api_msg: `Gagal (${new Date().toLocaleTimeString()}): ${result.msg}. Mencoba lagi...`
                    });
            }

            // Notif Telegram
            sendTelegramLog(
                `⚠️ <b>GAGAL - RETRYING...</b>\nTarget: ${data.targetNumber}\nProduk: ${data.productName}\nError: ${result.msg}`
            );
        }

    } catch (err) {
        console.error("CRITICAL ERROR:", err);
    }
}

// --- 5. START LOOP ---
console.log("Worker Autorun V3.4 (Native Fetch) Started...");
// Jalankan setiap 5 detik
setInterval(runWorker, 5000);