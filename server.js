const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// 미들웨어 설정
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase PostgreSQL 연결 설정
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres.dcdxzofzkvdbppsetarb:FbznL9Vvh3JgDTzL@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true';

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

// 테이블 자동 생성 (최초 1회 실행)
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS schedules (
                id SERIAL PRIMARY KEY,
                date VARCHAR(50) UNIQUE,
                max_workers INT DEFAULT 0,
                current_workers INT DEFAULT 0,
                status VARCHAR(20) DEFAULT 'open',
                is_active INT DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS applications (
                id SERIAL PRIMARY KEY,
                farm_name VARCHAR(100),
                phone VARCHAR(50),
                work_date VARCHAR(50),
                worker_count INT,
                notes TEXT,
                status VARCHAR(20) DEFAULT '접수완료',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS notice (
                id INT PRIMARY KEY CHECK (id = 1),
                content TEXT
            );

            INSERT INTO notice (id, content) 
            VALUES (1, '포천시 계절근로자 인력지원 신청 시스템입니다. 운영시간: 평일 09:00 ~ 17:00')
            ON CONFLICT (id) DO NOTHING;
        `);
        console.log('PostgreSQL 테이블 초기화 완료');
    } catch (err) {
        console.error('DB 초기화 에러:', err.message);
    }
};

initDb();

// [API] 공지사항 조회
app.get('/api/notice', async (req, res) => {
    try {
        const result = await pool.query('SELECT content FROM notice WHERE id = 1');
        res.json(result.rows[0] || { content: '' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API] 공지사항 수정 (관리자용)
app.post('/api/notice', async (req, res) => {
    const { content } = req.body;
    try {
        await pool.query('UPDATE notice SET content = $1 WHERE id = 1', [content]);
        res.json({ message: '공지사항이 수정되었습니다.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API] 신청 가능 일자 및 잔여 인원 조회
app.get('/api/schedules', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM schedules WHERE is_active = 1 ORDER BY date ASC');
        const rows = result.rows.map(item => {
            const remaining = item.max_workers - item.current_workers;
            const isClosed = remaining <= 0 || item.status === 'closed';
            return {
                ...item,
                remaining_workers: remaining > 0 ? remaining : 0,
                is_closed: isClosed
            };
        });
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API] 일별 정원 추가/수정 (관리자용)
app.post('/api/schedules', async (req, res) => {
    const { date, max_workers } = req.body;
    try {
        const sql = `
            INSERT INTO schedules (date, max_workers) 
            VALUES ($1, $2)
            ON CONFLICT (date) 
            DO UPDATE SET max_workers = EXCLUDED.max_workers
        `;
        await pool.query(sql, [date, max_workers]);
        res.json({ message: '일정이 저장되었습니다.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API] 농가 신청서 제출 (인원 초과 체크 포함)
app.post('/api/applications', async (req, res) => {
    const { farm_name, phone, work_date, worker_count, notes } = req.body;

    try {
        // 1. 해당 날짜 잔여 인원 확인
        const scheduleRes = await pool.query('SELECT * FROM schedules WHERE date = $1 AND is_active = 1', [work_date]);
        const schedule = scheduleRes.rows[0];

        if (!schedule) {
            return res.status(400).json({ error: '신청 불가능한 날짜입니다.' });
        }

        const remaining = schedule.max_workers - schedule.current_workers;
        if (remaining < worker_count) {
            return res.status(400).json({ error: `잔여 인원이 부족합니다. (신청 가능: ${remaining > 0 ? remaining : 0}명)` });
        }

        // 2. 신청서 저장
        const insertSql = `
            INSERT INTO applications (farm_name, phone, work_date, worker_count, notes) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id
        `;
        const insertRes = await pool.query(insertSql, [farm_name, phone, work_date, worker_count, notes]);
        const applicationId = insertRes.rows[0].id;

        // 3. 신청된 인원 수 증가
        await pool.query('UPDATE schedules SET current_workers = current_workers + $1 WHERE id = $2', [worker_count, schedule.id]);

        res.json({ message: '신청이 성공적으로 접수되었습니다.', applicationId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API] 신청 내역 조회 (전화번호 검색)
app.get('/api/applications/search', async (req, res) => {
    const { phone } = req.query;
    try {
        const result = await pool.query('SELECT * FROM applications WHERE phone = $1 ORDER BY id DESC', [phone]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API] 전체 신청 목록 조회 (관리자용)
app.get('/api/applications', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM applications ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// [API] 신청 취소
app.delete('/api/applications/:id', async (req, res) => {
    const appId = req.params.id;

    try {
        // 1. 기존 신청 정보 조회
        const appRes = await pool.query('SELECT * FROM applications WHERE id = $1', [appId]);
        const appData = appRes.rows[0];

        if (!appData) {
            return res.status(400).json({ error: '신청 내역을 찾을 수 없습니다.' });
        }

        // 2. 삭제 처리
        await pool.query('DELETE FROM applications WHERE id = $1', [appId]);

        // 3. 신청 일자의 current_workers 감소
        await pool.query(
            'UPDATE schedules SET current_workers = current_workers - $1 WHERE date = $2 AND current_workers >= $1',
            [appData.worker_count, appData.work_date]
        );

        res.json({ message: '신청이 취소되었습니다.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Vercel 서버리스 호스팅을 위해 app 모듈 내보내기
module.exports = app;

// 로컬 환경 실행 지원 (선택)
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`서버 가동 중: http://localhost:${PORT}`);
    });
}
