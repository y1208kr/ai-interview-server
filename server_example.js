/*
 * [V9 FINAL-URL-SHORTENER] Firebase Storage에서 생성된 긴 URL을
 * Bitly API를 통해 짧은 URL로 변환하여 저장하는 기능이 추가된 최종 버전입니다.
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios'); // Bitly API 요청을 위한 라이브러리

const app = express();
const port = process.env.PORT || 3000;

// --- 시작 전 필수 환경 변수 확인 ---
console.log('[System] 서버 시작 프로세스 개시...');
const requiredEnvVars = ['FIREBASE_SERVICE_ACCOUNT_KEY_JSON', 'FIREBASE_STORAGE_BUCKET', 'BITLY_ACCESS_TOKEN'];
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

/**
 * UTF-8 문자가 latin1(ISO-8859-1)으로 잘못 해석되어 깨졌을 때(Mojibake) 복원하는 함수.
 * @param {string} brokenString - 깨진 문자열
 * @returns {string} 복원된 문자열
 */
function fixEncoding(brokenString) {
    try {
        const buffer = Buffer.from(brokenString, 'latin1');
        return buffer.toString('utf8');
    } catch (e) {
        console.error('[Encoding] 문자열 복원 중 오류 발생:', e);
        return brokenString;
    }
}

/**
 * Bitly API를 사용하여 긴 URL을 짧게 만듭니다.
 * @param {string} longUrl - 단축할 긴 URL
 * @returns {Promise<string>} 단축된 URL 또는 실패 시 원본 URL
 */
async function shortenUrl(longUrl) {
    const endpoint = 'https://api-ssl.bitly.com/v4/shorten';
    const accessToken = process.env.BITLY_ACCESS_TOKEN;

    try {
        console.log(`[Bitly] URL 단축 시도: ${longUrl.substring(0, 50)}...`);
        const response = await axios.post(
            endpoint,
            { long_url: longUrl },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        const shortUrl = response.data.link;
        console.log(`[Bitly] URL 단축 성공: ${shortUrl}`);
        return shortUrl;
    } catch (error) {
        console.error('[Bitly] URL 단축 실패:', error.response ? error.response.data : error.message);
        return longUrl; // 단축에 실패하면 긴 원본 URL을 그대로 반환합니다.
    }
}


// --- 서버 메인 로직 ---
app.post('/upload-and-email', upload.any(), async (req, res) => {
    console.log("\n///////////////////////////////////////////////////////////");
    console.log("[Request] 새로운 면접 결과 요청을 받았습니다.");

    const files = req.files;
    const participantInfo = JSON.parse(fixEncoding(req.body.participantInfo));
    const participantName = participantInfo.name || 'UnknownParticipant';
    const timestamp = new Date().toISOString();
    const docId = `${timestamp}_${participantName}`;
    console.log(`[Request] 참가자 이름: ${participantName} (인코딩 복원 완료)`);

    const fileLinks = {};
    let isSuccess = true;

    // --- STEP 1: Firebase Storage 파일 업로드 및 URL 단축 ---
    try {
        console.log("\n--- STEP 1: Firebase Storage 파일 업로드 시작 ---");
        for (const file of files) {
            const originalFilename = fixEncoding(file.originalname);
            const destination = `results/${docId}/${originalFilename}`;
            console.log(`[Storage] '${originalFilename}' 업로드 시도... (경로: ${destination})`);
            
            await bucket.upload(file.path, {
                destination: destination,
                metadata: { contentType: file.mimetype }
            });
            
            const uploadedFile = bucket.file(destination);
            const [longUrl] = await uploadedFile.getSignedUrl({
                action: 'read',
                expires: '03-09-2491'
            });

            // ** [NEW] URL 단축 기능 호출 **
            const shortUrl = await shortenUrl(longUrl);

            console.log(`[Storage] '${originalFilename}' 업로드 및 링크 생성 성공.`);
            
            let key;
            if (file.fieldname.includes('audio')) {
                const qNum = file.fieldname.split('_')[1];
                key = `Audio_${qNum.toUpperCase()}`;
            } else if (file.fieldname.includes('consent')) key = 'PDF_Consent';
            else if (file.fieldname.includes('survey')) key = 'PDF_Survey';
            if (key) fileLinks[key] = shortUrl; // Firestore에는 짧은 URL을 저장합니다.
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
            const combinedData = { ...participantInfo, ...participantInfo.surveyData };
            const newRow = { 
                ...combinedData, 
                ...fileLinks,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };
            delete newRow.surveyData;
            
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

