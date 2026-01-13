const admin = require('firebase-admin');

// --- SETUP FIREBASE (METODE JSON UTUH) ---
try {
    // Membaca Secret JSON langsung. Tidak akan ada lagi error "missing project_id"
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
} catch (error) {
    console.error("GAGAL MEMBACA CREDENTIALS:", error.message);
    console.error("Pastikan Secret FIREBASE_SERVICE_ACCOUNT sudah diisi di GitHub Settings!");
    process.exit(1);
}

const db = admin.firestore();

// --- LOGIKA TRANSAKSI ---
async function runMassTransaction() {
    console.log(`[${new Date().toISOString()}] STARTING MASS TRANSACTION...`);

    try {
        // Contoh: Ambil user dari database
        const snapshot = await db.collection('users').limit(10).get(); 

        if (snapshot.empty) {
            console.log('Koneksi Database BERHASIL, tapi tidak ada data user.');
        } else {
            console.log(`Koneksi BERHASIL! Ditemukan ${snapshot.size} user.`);
            
            snapshot.forEach(doc => {
                console.log(`- User ID: ${doc.id}`);
                // Lanjutkan logika transaksi Anda disini...
            });
        }

    } catch (error) {
        console.error("CRITICAL ERROR SAAT AKSES DATABASE:", error);
        process.exit(1); 
    }
    console.log("JOB FINISHED.");
}

runMassTransaction();
