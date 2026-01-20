// api/telegram.js
import TelegramBot from 'node-telegram-bot-api';
import admin from 'firebase-admin';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

// --- KONFIGURASI ---
const token = '8576099469:AAHxURiNMnVhWdLqHLlAoX7ayAVX6HsCSiY';
const BASE_URL = 'https://www.pandawa-digital.store'; // Domain Anda

const firebaseConfig = {
    apiKey: "AIzaSyBnVxgxkS8InH1PQCMGe3cY8IvPqSN6dLo",
    authDomain: "ppob-3ea96.firebaseapp.com",
    projectId: "ppob-3ea96"
};

// Ambil Service Account dari Environment Variable Vercel
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT 
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) 
    : null;

const ALLOWED_ADMINS = ['doni888855519@gmail.com', 'suwarno8797@gmail.com'];

// Menu Keyboard Permanen
const mainMenu = {
    resize_keyboard: true,
    one_time_keyboard: false,
    keyboard: [
        [{ text: "🚀 RUN AUTO MASSAL" }],
        [{ text: "📋 Cek Antrian Preorder" }],
        [{ text: "🚪 Logout" }]
    ]
};

// --- INISIALISASI FIREBASE ---
if (!admin.apps.length) {
    if (serviceAccount) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
}
const db = admin.firestore();
const clientApp = initializeApp(firebaseConfig, 'clientBotApp');
const clientAuth = getAuth(clientApp);

// Helper Format Rupiah
const formatRp = (n) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(n);

// --- FUNGSI EKSEKUSI TRANSAKSI (DIPERBAIKI) ---
async function executeTransaction(poData) {
    const { targetNumber, provider, serverType, id } = poData;
    const reffId = `BOT-${Date.now()}-${id.substring(0,4)}`;
    
    try {
        let url = '';
        // Tentukan Endpoint berdasarkan Server
        if (serverType === 'KHFY') {
            url = `${BASE_URL}/api/relaykhfy?endpoint=/trx&produk=${provider}&tujuan=${targetNumber}&reff_id=${reffId}`;
        } else {
            // Default ICS Logic
            let icsType = 'xda';
            if(String(provider).toUpperCase().startsWith('XCL')) icsType = 'circle';
            else if(String(provider).toUpperCase().startsWith('XLA')) icsType = 'xla';
            
            url = `${BASE_URL}/api/relay?action=createTransaction&apikey=7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77&kode_produk=${provider}&nomor_tujuan=${targetNumber}&refid=${reffId}&type=${icsType}`;
        }

        const res = await fetch(url);
        const json = await res.json();
        
        let isSuccess = false;
        
        // LOGIKA PENANGKAPAN PESAN ERROR YANG LEBIH PINTAR
        // Prioritas: json.data.message > json.data.sn > json.message > json.msg
        let sn = json.message || json.msg || 'Gagal tanpa alasan jelas'; 

        if (json.data) {
            if (json.data.message) sn = json.data.message;
            else if (json.data.sn) sn = json.data.sn;
            else if (json.data.note) sn = json.data.note;
            else if (json.data.keterangan) sn = json.data.keterangan;
        }

        // Cek Status Sukses
        if (serverType === 'KHFY') {
            const msg = (json.message || json.msg || '').toLowerCase();
            isSuccess = (json.status === true || json.ok === true || msg.includes('sukses') || msg.includes('proses'));
        } else {
            isSuccess = json.success === true;
        }

        return { success: isSuccess, sn: sn, raw: json };
    } catch (e) {
        return { success: false, sn: "Error Koneksi: " + e.message, raw: null };
    }
}

// --- HANDLER UTAMA VERCEL ---
export default async function handler(req, res) {
    // 1. Validasi Method & Config
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!serviceAccount) return res.status(500).send('Service Account Missing in Vercel Env');

    const bot = new TelegramBot(token);
    const body = req.body;

    // ---------------------------------------------------------
    // A. HANDLE TOMBOL (CALLBACK QUERY)
    // ---------------------------------------------------------
    if (body.callback_query) {
        const query = body.callback_query;
        const chatId = query.message.chat.id;
        const data = query.data; 
        
        // Cek Sesi Login
        const sessionRef = db.collection('bot_sessions').doc(String(chatId));
        const sessionSnap = await sessionRef.get();
        if (!sessionSnap.exists || !sessionSnap.data().isLoggedIn) {
            await bot.answerCallbackQuery(query.id, { text: "Sesi habis. Login lagi." });
            return res.status(200).send('OK');
        }

        const [action, poId] = data.split('__'); // Separator double underscore

        try {
            const poRef = db.collection('preorders').doc(poId);
            const poSnap = await poRef.get();
            
            if (!poSnap.exists) {
                await bot.answerCallbackQuery(query.id, { text: "Data antrian sudah tidak ada." });
                // Hapus tombol agar tidak bingung
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
                return res.status(200).send('OK');
            }
            
            const poData = poSnap.data();
            const uid = poData.uid;
            const historyId = poData.historyId || ("PO-" + poId);

            // --- AKSI 1: RUN SINGLE (Tembak Server Satu Saja) ---
            if (action === 'RUN_SINGLE') {
                await bot.sendMessage(chatId, `🔄 Menembak Server untuk ${poData.targetNumber}...`);
                
                const result = await executeTransaction({ ...poData, id: poId });

                if (result.success) {
                    // SUKSES: Update History & Hapus Antrian
                    await db.runTransaction(async (t) => {
                        const hRef = db.collection('users').doc(uid).collection('history').doc(historyId);
                        const hDoc = await t.get(hRef);
                        if(hDoc.exists) {
                            t.update(hRef, { 
                                status: 'Sukses', 
                                api_msg: 'Sukses via Bot Run: ' + result.sn,
                                date_updated: new Date().toISOString()
                            });
                        }
                        t.delete(poRef); // Hapus dari antrian
                    });
                    await bot.sendMessage(chatId, `✅ <b>SUKSES!</b>\nTarget: ${poData.targetNumber}\nSN: ${result.sn}`, { parse_mode: 'HTML' });
                    // Hapus tombol
                    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
                } else {
                    // GAGAL: Catat Log, JANGAN hapus antrian
                    await poRef.update({ 
                        debugStatus: 'GAGAL',
                        debugLogs: `Bot Single Run: ${result.sn}`
                    });
                    await bot.sendMessage(chatId, `❌ <b>GAGAL KE SERVER</b>\nPesan: ${result.sn}\n\nSilakan coba lagi atau gunakan tombol Manual ACC/Refund.`, { parse_mode: 'HTML' });
                }
            }
            
            // --- AKSI 2: MANUAL ACC (Force Sukses) ---
            else if (action === 'MANUAL_ACC') {
                await db.runTransaction(async (t) => {
                    const hRef = db.collection('users').doc(uid).collection('history').doc(historyId);
                    t.update(hRef, { status: 'Sukses', api_msg: 'Diterima Manual (Bot)', date_updated: new Date().toISOString() });
                    t.delete(poRef);
                });
                await bot.sendMessage(chatId, `✅ Antrian ${poData.targetNumber} di-SET SUKSES Manual.`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            } 
            
            // --- AKSI 3: MANUAL REJ (Refund Saldo) ---
            else if (action === 'MANUAL_REJ') {
                await db.runTransaction(async (t) => {
                    const uRef = db.collection('users').doc(uid);
                    const hRef = uRef.collection('history').doc(historyId);
                    const uDoc = await t.get(uRef);
                    
                    const refundAmount = poData.price || 0;
                    const newBal = (uDoc.data().balance || 0) + refundAmount;

                    t.update(uRef, { balance: newBal });
                    t.update(hRef, { 
                        status: 'Gagal', 
                        api_msg: 'Refund Manual (Bot)', 
                        balance_final: newBal, 
                        is_refunded: true,
                        date_updated: new Date().toISOString() 
                    });
                    t.delete(poRef);
                });
                await bot.sendMessage(chatId, `❌ Antrian ${poData.targetNumber} di-REFUND.`);
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
            }
            
            await bot.answerCallbackQuery(query.id);

        } catch (e) {
            await bot.sendMessage(chatId, `⚠️ Error: ${e.message || e}`);
        }
        return res.status(200).send('OK');
    }

    // ---------------------------------------------------------
    // B. HANDLE PESAN TEKS
    // ---------------------------------------------------------
    if (!body.message || !body.message.text) return res.status(200).send('OK');

    const chatId = body.message.chat.id;
    const text = body.message.text;
    const msgId = body.message.message_id;

    // Cek Session
    const sessionRef = db.collection('bot_sessions').doc(String(chatId));
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.exists ? sessionSnap.data() : { isLoggedIn: false };

    try {
        // --- LOGOUT ---
        if (text === '/logout' || text === '🚪 Logout') {
            await sessionRef.delete();
            await bot.sendMessage(chatId, "👋 Logout berhasil.", { reply_markup: { remove_keyboard: true } });
            return res.status(200).send('OK');
        }
        
        // --- START ---
        if (text === '/start') {
            if (session.isLoggedIn) {
                await bot.sendMessage(chatId, `⚙️ *DEBUGGER MODE*\nLogin sebagai: ${session.email}`, { parse_mode: 'Markdown', reply_markup: mainMenu });
            } else {
                await bot.sendMessage(chatId, `🔐 *LOGIN DEBUGGER*\nFormat: \`/login email password\``, { parse_mode: 'Markdown' });
            }
        }
        
        // --- LOGIN ---
        else if (text.startsWith('/login')) {
            const parts = text.split(' ');
            if (parts.length !== 3) {
                await bot.sendMessage(chatId, "❌ Format salah.");
            } else {
                const email = parts[1];
                const password = parts[2];
                try { await bot.deleteMessage(chatId, msgId); } catch(e){}

                if (!ALLOWED_ADMINS.includes(email)) return res.status(200).send('OK');
                try {
                    await signInWithEmailAndPassword(clientAuth, email, password);
                    await sessionRef.set({ isLoggedIn: true, email: email, loginAt: new Date().toISOString() });
                    await bot.sendMessage(chatId, `✅ *Login Sukses!*`, { parse_mode: 'Markdown', reply_markup: mainMenu });
                } catch (error) {
                    await bot.sendMessage(chatId, `❌ Login Gagal. Password salah?`);
                }
            }
        }

        // --- PROTEKSI SESSION ---
        else if (!session.isLoggedIn) {
            await bot.sendMessage(chatId, "🔒 Akses ditolak. Silakan login.");
        }

        // --- MENU 1: RUN AUTO MASSAL ---
        else if (text === '🚀 RUN AUTO MASSAL') {
            await bot.sendMessage(chatId, "🔄 Menjalankan Batch (Max 5 Antrian)...");
            
            const poSnap = await db.collection('preorders').orderBy('timestamp', 'desc').limit(5).get();

            if (poSnap.empty) {
                await bot.sendMessage(chatId, "✅ Antrian Kosong / Bersih.");
            } else {
                let report = "📝 <b>Hasil Eksekusi Massal:</b>\n\n";
                let successCount = 0;
                
                for (const doc of poSnap.docs) {
                    const d = doc.data();
                    // Lewati yang status debugnya sudah 'TERBELI' (tapi belum terhapus)
                    if (d.debugStatus === 'TERBELI') continue;

                    const result = await executeTransaction({ ...d, id: doc.id });
                    
                    if (result.success) {
                        successCount++;
                        // Sukses -> Update History & Hapus PO
                        await db.runTransaction(async (t) => {
                            const hRef = db.collection('users').doc(d.uid).collection('history').doc(d.historyId || "PO-"+doc.id);
                            const hDoc = await t.get(hRef);
                            if(hDoc.exists) t.update(hRef, { 
                                status: 'Sukses', 
                                api_msg: 'Bot Massal: ' + result.sn, 
                                date_updated: new Date().toISOString() 
                            });
                            t.delete(doc.ref);
                        });
                        report += `✅ ${d.targetNumber}: Sukses\n`;
                    } else {
                        // Gagal -> Update Status Debug (Jangan dihapus)
                        await doc.ref.update({ debugStatus: 'GAGAL', debugLogs: `Massal: ${result.sn}` });
                        report += `❌ ${d.targetNumber}: ${result.sn}\n`;
                    }
                }
                
                if (successCount === 0 && report.includes('❌')) report += "\n💡 Gunakan 'Cek Antrian' untuk penanganan manual.";
                
                await bot.sendMessage(chatId, report, { parse_mode: 'HTML', reply_markup: mainMenu });
            }
        }

        // --- MENU 2: CEK ANTRIAN (TAMPILKAN MENU PER ITEM) ---
        else if (text === '📋 Cek Antrian Preorder') {
            const poSnap = await db.collection('preorders').orderBy('timestamp', 'desc').limit(5).get();

            if (poSnap.empty) {
                await bot.sendMessage(chatId, "✅ Tidak ada antrian preorder.", { reply_markup: mainMenu });
            } else {
                await bot.sendMessage(chatId, "👇 <b>Daftar 5 Antrian Teratas:</b>", { parse_mode: 'HTML', reply_markup: mainMenu });
                
                for (const doc of poSnap.docs) {
                    const d = doc.data();
                    const statusIcon = d.debugStatus === 'GAGAL' ? '🔴 GAGAL' : '🟡 PENDING';
                    
                    // Tampilkan Log Error jika ada (dipotong biar tidak kepanjangan)
                    const logInfo = d.debugLogs ? `\nNote: <i>${d.debugLogs.substring(0, 40)}...</i>` : '';

                    const msg = `<b>${statusIcon}</b>\n` +
                                `User: <code>${d.username}</code>\n` +
                                `Target: <code>${d.targetNumber}</code>\n` +
                                `Produk: ${d.provider} (${d.serverType || 'KHFY'})` +
                                logInfo;

                    // 3 Tombol Sakti
                    const buttons = [
                        [{ text: "🚀 RUN SERVER", callback_data: `RUN_SINGLE__${doc.id}` }],
                        [
                            { text: "✅ Force Sukses", callback_data: `MANUAL_ACC__${doc.id}` },
                            { text: "❌ Refund", callback_data: `MANUAL_REJ__${doc.id}` }
                        ]
                    ];

                    await bot.sendMessage(chatId, msg, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: buttons }
                    });
                }
            }
        }

    } catch (error) {
        console.error("Bot Error:", error);
        await bot.sendMessage(chatId, "⚠️ Error System: " + error.message);
    }

    return res.status(200).send('OK');
}