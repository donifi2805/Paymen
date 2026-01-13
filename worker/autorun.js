// worker/autorun.js
const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE ---
// Kita merakit sertifikat dari Environment Variables agar aman
const serviceAccount = {
  "type": "service_account",
  "project_id": process.env.FIREBASE_PROJECT_ID,
  "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
  "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Fix untuk newlines
  "client_email": process.env.FIREBASE_CLIENT_EMAIL,
  "client_id": process.env.FIREBASE_CLIENT_ID,
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": process.env.FIREBASE_CLIENT_CERT_URL
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// --- 2. LOGIC TRANSAKSI MASAL ---
async function runMassTransaction() {
    console.log(`[${new Date().toISOString()}] STARTING MASS TRANSACTION...`);

    try {
        // Contoh: Ambil user yang statusnya 'active' dan punya saldo cukup
        // Ganti 'users' sesuai nama koleksi database Anda
        const snapshot = await db.collection('users').limit(50).get(); 

        if (snapshot.empty) {
            console.log('Tidak ada target user.');
            return;
        }

        for (const doc of snapshot.docs) {
            const data = doc.data();
            console.log(`Processing User: ${data.email || doc.id}`);

            // >> LOGIC KE API PROVIDER (ICS/KHFY) <<
            // Disini kita pakai fetch langsung, tidak perlu lewat relay.js
            
            // CONTOH TEMBAK KHFY
            const payload = {
                api_key: process.env.KHFY_API_KEY, // Ambil dari Secrets
                action: 'order',
                service: 'PLN20', // Contoh hardcode
                target: data.nomor_hp // Ambil dari database
            };

            const response = await fetch('https://panel.khfy-store.com/api_v2', {
                method: 'POST',
                headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                body: new URLSearchParams(payload)
            });

            const result = await response.json();
            console.log(`Result: `, result);

            // Jeda 1 detik (Rate Limiting)
            await new Promise(r => setTimeout(r, 1000));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        process.exit(1); // Error code supaya GitHub memberitahu gagal
    }
    console.log("JOB FINISHED.");
}

runMassTransaction();
