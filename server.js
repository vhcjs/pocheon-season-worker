const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;

// 미들웨어 설정
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB 연결
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('DB 연결 실패:', err.message);
    } else {
        console.log('SQLite DB에 성공적으로 연결되었습니다.');
    }
});

// 테이블 초기화
db.serialize(() => {
    // 1. 일정(쿼터) 테이블
    db.run(`CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE,
        max_workers INTEGER DEFAULT 0,
        current_workers INTEGER DEFAULT 0,
        status TEXT DEFAULT 'open',
        is_active INTEGER DEFAULT 1
    )`);

    // 2. 신청서 테이블
    db.run(`CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        farm_name TEXT,
        phone TEXT,
        work_date TEXT,
        worker_count INTEGER,
        notes TEXT,
        status TEXT DEFAULT '접수완료',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. 공지사항 테이블
    db.run(`CREATE TABLE IF NOT EXISTS notice (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT
    )`);

    // 기본 공지사항 세팅
    db.run(`INSERT OR IGNORE INTO notice (id, content) VALUES (1, '포천시 계절근로자 인력지원 신청 시스템입니다. 운영시간: 평일 09:00 ~ 17:00')`);
});

// [API] 공지사항 조회
app.get('/api/notice', (req, res) => {
    db.get(`SELECT content FROM notice WHERE id = 1`, [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { content: '' });
    });
});

// [API] 공지사항 수정 (관리자용)
app.post('/api/notice', (req, res) => {
    const { content } = req.body;
    db.run(`UPDATE notice SET content = ? WHERE id = 1`, [content], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: '공지사항이 수정되었습니다.' });
    });
});

// [API] 신청 가능 일자 및 잔여 인원 조회 (0명 시 자동 마감 처리)
app.get('/api/schedules', (req, res) => {
    const sql = `SELECT * FROM schedules WHERE is_active = 1 ORDER BY date ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const result = rows.map(item => {
            const remaining = item.max_workers - item.current_workers;
            const isClosed = remaining <= 0 || item.status === 'closed';
            return {
                ...item,
                remaining_workers: remaining > 0 ? remaining : 0,
                is_closed: isClosed
            };
        });
        res.json(result);
    });
});

// [API] 일별 정원 추가/수정 (관리자용)
app.post('/api/schedules', (req, res) => {
    const { date, max_workers } = req.body;
    const sql = `INSERT INTO schedules (date, max_workers) VALUES (?, ?)
                 ON CONFLICT(date) DO UPDATE SET max_workers = excluded.max_workers`;
    db.run(sql, [date, max_workers], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: '일정이 저장되었습니다.' });
    });
});

// [API] 농가 신청서 제출 (인원 초과 체크 포함)
app.post('/api/applications', (req, res) => {
    const { farm_name, phone, work_date, worker_count, notes } = req.body;

    // 1. 해당 날짜 잔여 인원 확인
    const checkSql = `SELECT * FROM schedules WHERE date = ? AND is_active = 1`;
    db.get(checkSql, [work_date], (err, schedule) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!schedule) return res.status(400).json({ error: '신청 불가능한 날짜입니다.' });

        const remaining = schedule.max_workers - schedule.current_workers;
        if (remaining < worker_count) {
            return res.status(400).json({ error: `잔여 인원이 부족합니다. (신청 가능: ${remaining > 0 ? remaining : 0}명)` });
        }

        // 2. 신청서 저장
        const insertSql = `INSERT INTO applications (farm_name, phone, work_date, worker_count, notes) VALUES (?, ?, ?, ?, ?)`;
        db.run(insertSql, [farm_name, phone, work_date, worker_count, notes], function (err) {
            if (err) return res.status(500).json({ error: err.message });

            // 3. 신청된 인원 수 증가
            const updateSql = `UPDATE schedules SET current_workers = current_workers + ? WHERE id = ?`;
            db.run(updateSql, [worker_count, schedule.id], (err) => {
                if (err) console.error('인원수 업데이트 실패:', err);
                res.json({ message: '신청이 성공적으로 접수되었습니다.', applicationId: this.lastID });
            });
        });
    });
});

// [API] 신청 내역 조회 (전화번호 검색)
app.get('/api/applications/search', (req, res) => {
    const { phone } = req.query;
    const sql = `SELECT * FROM applications WHERE phone = ? ORDER BY id DESC`;
    db.all(sql, [phone], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [API] 전체 신청 목록 조회 (관리자용)
app.get('/api/applications', (req, res) => {
    const sql = `SELECT * FROM applications ORDER BY id DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [API] 신청 취소
app.delete('/api/applications/:id', (req, res) => {
    const appId = req.params.id;
    
    // 1. 기존 신청 정보 조회
    db.get(`SELECT * FROM applications WHERE id = ?`, [appId], (err, app) => {
        if (err || !app) return res.status(400).json({ error: '신청 내역을 찾을 수 없습니다.' });

        // 2. 삭제 처리
        db.run(`DELETE FROM applications WHERE id = ?`, [appId], function(err) {
            if (err) return res.status(500).json({ error: err.message });

            // 3. 신청 일자의 current_workers 감소
            db.run(`UPDATE schedules SET current_workers = current_workers - ? WHERE date = ? AND current_workers >= ?`, 
                [app.worker_count, app.work_date, app.worker_count]);

            res.json({ message: '신청이 취소되었습니다.' });
        });
    });
});

// 서버 가동
app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`🚀 포천시 계절근로자 서버 가동중!`);
    console.log(`   접속 주소: http://localhost:${PORT}`);
    console.log(`=================================`);
});