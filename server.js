const WebSocket = require('ws'); // Mengimpor library WebSocket untuk Node.js

const PORT = process.env.PORT || 8080; // Menentukan port server. Jika ada di environment variable, pakai itu, kalau tidak pakai 8080.

const wss = new WebSocket.Server({ port: PORT }); // Membuat instance server WebSocket baru pada port yang ditentukan.

console.log(`WebSocket Signaling Server berjalan pada ws://localhost:${PORT}`);
console.log(`Pastikan aplikasi klien Anda terhubung ke alamat IP:port ini.`);
// Pesan log awal saat server mulai, memberitahu di mana server berjalan.

const rooms = {};
// Objek untuk menyimpan 'room' atau ruangan panggilan. Setiap room akan berisi daftar klien (peer) yang bergabung.
// Struktur: { 'nama_room': { 'peerId1': ws_obj1, 'peerId2': ws_obj2 } }

const wsMetadata = new Map();
// Map untuk menyimpan metadata tambahan (seperti roomId dan peerId) yang terkait dengan setiap objek WebSocket (ws).
// Berguna saat koneksi ditutup (ws.on('close')) untuk mengetahui peer mana yang keluar dari room mana.

wss.on('connection', ws => {
    console.log('Klien baru terhubung.');
    // Event listener: Akan dijalankan setiap kali ada klien baru terhubung ke server WebSocket.
    // 'ws' adalah objek WebSocket untuk koneksi klien yang baru saja terhubung.

    ws.on('message', message => {
        // Event listener: Akan dijalankan setiap kali klien ini mengirim pesan ke server.
        let parsedMessage;
        try {
            // Mengubah buffer pesan menjadi string, lalu mengurai string JSON menjadi objek JavaScript.
            parsedMessage = JSON.parse(message.toString());
            console.log('Menerima pesan: %s', JSON.stringify(parsedMessage));
        } catch (e) {
            // Menangani error jika pesan yang diterima bukan JSON yang valid.
            console.error('Gagal mengurai pesan JSON dari klien:', message.toString(), e);
            if (ws.readyState === WebSocket.OPEN) {
                // Memberi tahu klien jika format pesan tidak valid.
                ws.send(JSON.stringify({ type: 'error', message: 'Format pesan JSON tidak valid.', senderId: 'server' }));
            }
            return; // Hentikan pemrosesan jika pesan tidak valid.
        }

        const { type, roomId, senderId, receiverId } = parsedMessage;
        // Mengekstrak properti penting dari pesan JSON.

        if (!type || !senderId || !roomId) {
            // Validasi dasar: Memastikan pesan memiliki tipe, ID pengirim, dan ID ruangan.
            console.warn('Pesan tidak valid: "type", "senderId", atau "roomId" hilang.', parsedMessage);
            if (ws.readyState === WebSocket.OPEN) {
                // Memberi tahu klien jika pesan signaling tidak lengkap.
                ws.send(JSON.stringify({ type: 'error', message: 'Pesan signaling tidak lengkap (type, senderId, atau roomId hilang).', senderId: 'server' }));
            }
            return;
        }

        // Menggunakan switch case untuk memproses berbagai jenis pesan signaling.
        switch (type) {
            case 'join':
                // Logika ketika klien ingin bergabung ke sebuah room.
                if (!rooms[roomId]) {
                    rooms[roomId] = {}; // Jika room belum ada, buat room baru.
                    console.log(`Room '${roomId}' dibuat.`);
                }

                if (rooms[roomId][senderId]) {
                    // Cek apakah peer sudah ada di room (hindari duplikasi).
                    console.warn(`Peringatan: Peer '${senderId}' sudah ada di room '${roomId}'.`);
                    if (ws.readyState === WebSocket.OPEN) {
                        // Kirim pesan error kembali ke klien yang mencoba join lagi.
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Anda sudah bergabung di room '${roomId}'.`,
                            senderId: 'server',
                            originalType: 'join'
                        }));
                    }
                    return;
                }

                // Menyimpan metadata (room ID dan peer ID) untuk objek WebSocket ini.
                wsMetadata.set(ws, { roomId, peerId: senderId });

                // Iterasi melalui peer-peer yang sudah ada di room.
                Object.keys(rooms[roomId]).forEach(existingPeerId => {
                    const existingPeerWs = rooms[roomId][existingPeerId];
                    if (existingPeerWs && existingPeerWs.readyState === WebSocket.OPEN) {
                        // Memberi tahu semua peer yang sudah ada di room bahwa ada peer baru yang bergabung.
                        existingPeerWs.send(JSON.stringify({
                            type: 'join',
                            roomId: roomId,
                            senderId: senderId // Mengirimkan ID peer yang baru bergabung
                        }));

                        // Memberi tahu peer baru tentang peer-peer yang sudah ada di room.
                        // Ini penting agar peer baru bisa memulai negosiasi dengan peer lama.
                        ws.send(JSON.stringify({
                            type: 'join',
                            roomId: roomId,
                            senderId: existingPeerId // Mengirimkan ID peer yang sudah ada
                        }));
                    }
                });

                rooms[roomId][senderId] = ws; // Menambahkan objek WebSocket peer baru ke daftar room.
                console.log(`Peer '${senderId}' bergabung ke room '${roomId}'. Total peer di room: ${Object.keys(rooms[roomId]).length}`);
                break;

            case 'offer':
            case 'answer':
            case 'candidate':
                // Ini adalah pesan signaling utama WebRTC (SDP offer/answer, ICE candidates).
                // Server hanya meneruskan pesan ini dari pengirim ke penerima yang dituju.
                if (!receiverId) {
                    // Memastikan ada 'receiverId' untuk pesan-pesan ini karena ditujukan ke peer spesifik.
                    console.warn(`Pesan tipe '${type}' dari '${senderId}' memerlukan 'receiverId'. Pesan:`, parsedMessage);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'error', message: `'${type}' memerlukan 'receiverId'.`, originalType: type, senderId: 'server' }));
                    }
                    return;
                }

                const targetPeerWs = rooms[roomId]?.[receiverId];
                // Mendapatkan objek WebSocket dari peer tujuan (receiverId) dari daftar room.

                if (targetPeerWs && targetPeerWs.readyState === WebSocket.OPEN) {
                    // Jika peer target ditemukan dan koneksinya aktif, teruskan pesan.
                    targetPeerWs.send(JSON.stringify(parsedMessage));
                    console.log(`Meneruskan pesan '${type}' dari '${senderId}' ke '${receiverId}' di room '${roomId}'.`);
                } else {
                    // Jika peer target tidak ditemukan atau tidak aktif.
                    console.warn(`Peer target '${receiverId}' di room '${roomId}' tidak ditemukan atau tidak aktif untuk pesan '${type}' dari '${senderId}'.`);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: `Peer target '${receiverId}' tidak ditemukan atau tidak aktif.`,
                            originalType: type,
                            senderId: 'server',
                            receiverId: senderId // Mengirimkan error kembali ke pengirim
                        }));
                    }
                }
                break;

            case 'leave':
                // Logika ketika klien ingin meninggalkan room.
                handlePeerLeave(ws, roomId, senderId);
                break;

            default:
                // Penanganan untuk tipe pesan yang tidak dikenal.
                console.warn('Tipe pesan tidak dikenal dari klien:', type, parsedMessage);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Tipe pesan tidak dikenal.', originalType: type, senderId: 'server' }));
                }
                break;
        }
    });

    ws.on('close', () => {
        // Event listener: Akan dijalankan ketika koneksi klien ditutup (misalnya, klien menutup browser/aplikasi).
        console.log('Koneksi klien ditutup.');
        const metadata = wsMetadata.get(ws); // Mengambil metadata peer yang terputus menggunakan objek WebSocket-nya.
        if (metadata) {
            handlePeerLeave(ws, metadata.roomId, metadata.peerId); // Memanggil fungsi untuk menangani peer yang meninggalkan room.
            wsMetadata.delete(ws); // Menghapus metadata dari map setelah peer meninggalkan room.
        } else {
            console.log('Koneksi ditutup tanpa metadata room/peer yang terkait.');
        }
    });

    ws.on('error', error => {
        // Event listener: Akan dijalankan jika terjadi error pada koneksi WebSocket (misalnya, masalah jaringan).
        console.error('WebSocket error terjadi:', error);
    });
});

// Fungsi pembantu untuk menangani ketika seorang peer meninggalkan room.
function handlePeerLeave(wsToClose, roomId, peerId) {
    if (rooms[roomId] && rooms[roomId][peerId]) {
        delete rooms[roomId][peerId]; // Menghapus peer dari room yang sesuai.

        console.log(`Peer '${peerId}' meninggalkan room '${roomId}'. Sisa peer di room: ${Object.keys(rooms[roomId]).length}`);

        // Memberi tahu semua peer yang tersisa di room bahwa peer ini telah pergi.
        Object.keys(rooms[roomId]).forEach(existingPeerId => {
            const existingPeerWs = rooms[roomId][existingPeerId];
            if (existingPeerWs && existingPeerWs.readyState === WebSocket.OPEN) {
                existingPeerWs.send(JSON.stringify({
                    type: 'leave',
                    roomId: roomId,
                    senderId: peerId // Menginformasikan peer yang tersisa siapa yang meninggalkan
                }));
            }
        });

        if (Object.keys(rooms[roomId]).length === 0) {
            delete rooms[roomId]; // Jika room menjadi kosong setelah peer ini pergi, hapus room tersebut.
            console.log(`Room '${roomId}' sekarang kosong dan telah dihapus.`);
        }
    } else {
        console.warn(`Percobaan untuk menangani leave untuk peer '${peerId}' di room '${roomId}', tetapi peer tidak ditemukan di room tersebut.`);
    }

    // Menutup koneksi WebSocket dari peer yang meninggalkan room, jika masih terbuka.
    if (wsToClose.readyState === WebSocket.OPEN) {
        wsToClose.close();
    }
}

wss.on('listening', () => {
    // Event listener: Akan dijalankan ketika server WebSocket berhasil di-bind ke port dan siap menerima koneksi.
    console.log(`Server signaling telah berjalan dan siap menerima koneksi pada port ${PORT}.`);
});