// File: api/cron_preorder.js
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// --- 1. SETUP FIREBASE ADMIN ---
// Kita ambil kunci rahasia dari Environment Variable Vercel
// (Nanti kita setting di langkah Tahap 2)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

// --- 2. KONFIGURASI SUPPLIER (Hardcode dari data Anda) ---
const KHFY_CONFIG = { 
    apiKey: "8F1199C1-483A-4C96-825E-F5EBD33AC60A", 
    baseUrl: "https://panel.khfy-store.com/api_v2" 
};
const ICS_CONFIG = { 
    apiKey: "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77", 
    baseUrl: "https://api.ics-store.my.id/api/reseller" 
};

// --- 3. PASSWORD PENGAMAN (GANTI INI!) ---
const CRON_PASSWORD = "RAHASIA_DAPUR_PANDAWA"; 

export default async function handler(req, res) {
    // Cek Password di URL (?kunci=...)
    const { kunci } = req.query;
    if (kunci !== CRON_PASSWORD) {
        return res.status(401).json({ success: false, message: 'Akses Ditolak: Password Salah!' });
    }

    try {
        // Ambil antrian Preorder (Maksimal 5 agar tidak timeout di Vercel Free)
        const snapshot = await db.collection('preorders')
            .orderBy('timestamp', 'asc')
            .limit(5) 
            .get();
        
        if (snapshot.empty) {
            return res.status(200).json({ success: true, message: 'Antrian kosong.' });
        }

        let processed = 0;
        let successCount = 0;
        let logs = [];

        // Loop data antrian
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const poId = doc.id;
            
            // Skip jika status sudah TERBELI (Safety)
            if (data.debugStatus === 'TERBELI') continue;

            const serverType = data.serverType || 'KHFY'; 
            const reffId = `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            let isSuccess = false;
            let sn = '';
            
            // --- EKSEKUSI PEMBELIAN KE PUSAT ---
            try {
                if (serverType === 'ICS') {
                    // Logic ICS
                    const icsUrl = `${ICS_CONFIG.baseUrl}/trx?apikey=${ICS_CONFIG.apiKey}`;
                    const icsBody = {
                        product_code: data.provider,
                        dest_number: data.targetNumber,
                        ref_id_custom: reffId
                    };
                    const apiRes = await fetch(icsUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(icsBody)
                    });
                    const result = await apiRes.json();
                    
                    // Cek respon ICS
                    if (result.success === true && result.data && result.data.status !== 'Gagal') {
                        isSuccess = true;
                        sn = result.data.message || 'Proses Server ICS';
                    }
                } else {
                    // Logic KHFY
                    const khfyUrl = `${KHFY_CONFIG.baseUrl}/trx?api_key=${KHFY_CONFIG.apiKey}&kode_produk=${data.provider}&tujuan=${data.targetNumber}&reff_id=${reffId}`;
                    const apiRes = await fetch(khfyUrl);
                    const result = await apiRes.json();

                    // Cek respon Khfy
                    const msg = (result.message || '').toLowerCase();
                    if ((result.ok || result.status) && (msg.includes('sukses') || msg.includes('proses'))) {
                        isSuccess = true;
                        if(result.data) sn = result.data.sn || result.data.message || 'Proses Server Khfy';
                    }
                }
            } catch (err) {
                console.error(`Error API ${serverType}:`, err);
            }

            // --- UPDATE DATABASE ---
            if (isSuccess) {
                successCount++;
                // 1. Update History User jadi SUKSES
                const historyId = data.historyId || `PO-${poId}`;
                const historyRef = db.collection('users').doc(data.uid).collection('history').doc(historyId);
                
                const hSnap = await historyRef.get();
                if (hSnap.exists && hSnap.data().status === 'Pending') {
                    await historyRef.update({
                        status: 'Sukses',
                        api_msg: `Auto Run: ${sn}`,
                        trx_id: reffId,
                        date_updated: new Date().toISOString()
                    });
                }

                // 2. Hapus dari Preorder (Karena sudah sukses)
                await db.collection('preorders').doc(poId).delete();
                logs.push(`${data.targetNumber}: SUKSES`);
            } else {
                // Gagal (Stok habis/Gangguan) -> Biarkan di antrian, update log saja
                await db.collection('preorders').doc(poId).update({
                    debugStatus: 'RETRY',
                    debugLogs: `[${new Date().toLocaleTimeString()}] Retrying...`
                });
                logs.push(`${data.targetNumber}: MENUNGGU STOK`);
            }
            processed++;
        }

        return res.status(200).json({ 
            success: true, 
            processed, 
            success_trx: successCount,
            logs 
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}