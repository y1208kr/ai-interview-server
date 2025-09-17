/*
 * [V17 FINAL-DEBUGGING-FIX] 모든 텍스트 데이터에 대해 인코딩 복원 로직을
 * 적용하고, 각 필드의 복원 전/후를 로그에 명확히 기록하여 최종 디버깅을 수행합니다.
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000;

// --- 시작 전 필수 환경 변수 확인 ---
console.log('[System] 서버 시작 프로세스 개시...');
const requiredEnvVars = ['FIREBASE_SERVICE_ACCOUNT_KEY_JSON', 'FIREBASE_STORAGE_BUCKET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error(`[FATAL ERROR] 서버 시작 실패! 아래의 필수 환경 변수가 설정되지 않았습니다:`);
    console.error(missingVars.join(', '));
    process.exit(1);
}
console.log('[System] 모든 환경 변수가 설정된 것을 확인했습니다.');

// --- Firebase Admin SDK 초기화 ---
try {
    console.log('[Auth] Firebase 서비스 계정 키 파싱 시도...');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON);
    console.log('[Auth] Firebase 서비스 계정 키 파싱 성공.');

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
    console.log('[Auth] Firebase Admin SDK 초기화 성공.');
} catch (error) {
    console.error('[FATAL ERROR] Firebase 서비스 계정 키(.json) 형식이 올바르지 않습니다. Render 환경 변수 값을 다시 확인해주세요.', error);
    process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

app.use(cors());
const upload = multer({ dest: 'uploads/' });

// --- 서버 메인 로직 ---
app.post('/upload-and-email', upload.any(), async (req, res) => {
    console.log("\n///////////////////////////////////////////////////////////");
    console.log(`[V17-DEBUG] 새로운 면접 결과 요청을 받았습니다.`);

    const files = req.files;
    const timestamp = new Date().toISOString();

    // [FINAL DEBUGGING FIX]
    console.log('[Encoding] 수신된 텍스트 필드 인코딩 복원을 시작합니다...');
    const participantData = {};
    for (const key in req.body) {
        const value = req.body[key];
        if (typeof value === 'string') {
            const restoredValue = Buffer.from(value, 'latin1').toString('utf8');
            console.log(`[Encoding]  - KEY: ${key}, ORIGINAL: "${value}", RESTORED: "${restoredValue}"`);
            participantData[key] = restoredValue;
        } else {
            participantData[key] = value;
        }
    }
    console.log('[Encoding] 인코딩 복원 완료.');

    const participantName = participantData.name || 'UnknownParticipant';
    const docId = `${timestamp}_${participantName}`;
    console.log(`[Request] 참가자 이름: ${participantName}`);

    const fileLinks = {};
    let isSuccess = true;

    // --- STEP 1: Firebase Storage 파일 업로드 ---
    try {
        console.log("\n--- STEP 1: Firebase Storage 파일 업로드 시작 ---");
        for (const file of files) {
            const originalFilename = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const destination = `results/${docId}/${originalFilename}`;
            console.log(`[Storage] '${originalFilename}' 업로드 시도...`);
            
            await bucket.upload(file.path, {
                destination: destination,
                metadata: { contentType: file.mimetype }
            });
            
            const uploadedFile = bucket.file(destination);
            const [url] = await uploadedFile.getSignedUrl({
                action: 'read',
                expires: '03-09-2491'
            });
            console.log(`[Storage] '${originalFilename}' 업로드 및 링크 생성 성공.`);
            
            let key;
            if (file.fieldname.startsWith('audio_q_')) {
                const qNum = file.fieldname.split('_')[2];
                key = `Audio_Q${qNum}`;
            } else if (file.fieldname.includes('consent')) {
                key = 'PDF_Consent';
            } else if (file.fieldname.includes('survey')) {
                key = 'PDF_Survey';
            }
            if (key) fileLinks[key] = url;
        }
        console.log("--- STEP 1: Firebase Storage 파일 업로드 완료 ---\n");
    } catch (error) {
        console.error("\n[FATAL ERROR] Firebase Storage 처리 중 심각한 오류가 발생했습니다:", error);
        isSuccess = false;
    }

    // --- STEP 2: Firestore 데이터 추가 ---
    if (isSuccess) {
        try {
            console.log("--- STEP 2: Firestore 데이터 추가 시작 ---");
            const newRow = { ...participantData, ...fileLinks, timestamp };
            await db.collection('interviewResults').doc(docId).set(newRow);
            console.log(`[Firestore] Document ID '${docId}' 로 데이터 추가 성공.`);
            console.log("--- STEP 2: Firestore 데이터 추가 완료 ---\n");
        } catch (error) {
            console.error("\n[FATAL ERROR] Firestore 처리 중 심각한 오류가 발생했습니다:", error);
            isSuccess = false;
        }
    }

    // --- 최종 응답 ---
    if (isSuccess) {
        res.status(200).send('성공적으로 제출되어 연구자에게 전달되었습니다.');
    } else {
        res.status(500).send('서버 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.');
    }

    console.log("[System] 임시 파일 정리 작업을 수행합니다.");
    files.forEach(file => fs.unlinkSync(file.path));
    console.log("[System] 모든 작업이 완료되었습니다.\n");
});

app.listen(port, () => {
    console.log(`[System] 서버가 http://localhost:${port} 에서 실행 중입니다.`);
    if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
});

