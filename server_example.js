/*
 * [V6 FINAL-FIX] 'supportsAllDrives: true' 플래그를 추가하여
 * 공유 드라이브에서 발생하는 'storageQuotaExceeded' 오류를 해결하는 최종 버전입니다.
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

const app = express();
const port = process.env.PORT || 3000;

// --- 시작 전 필수 환경 변수 확인 ---
console.log('[System] 서버 시작 프로세스 개시...');
const requiredEnvVars = [
    'SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY',
    'GOOGLE_DRIVE_FOLDER_ID'
];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error(`[FATAL ERROR] 서버 시작 실패! 아래의 필수 환경 변수가 설정되지 않았습니다:`);
    console.error(missingVars.join(', '));
    process.exit(1);
}
console.log('[System] 모든 환경 변수가 설정된 것을 확인했습니다.');

// --- Google API 설정 ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

// [자동 교정 기능] Private Key를 더 안전하게 처리합니다.
let rawKey = (process.env.GOOGLE_PRIVATE_KEY || '').trim();
if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
    console.log('[Auth] Private Key를 감싸는 큰따옴표를 감지하여 자동으로 제거합니다.');
    rawKey = rawKey.substring(1, rawKey.length - 1);
}
const GOOGLE_PRIVATE_KEY = rawKey.replace(/\\n/g, '\n');

if (!GOOGLE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
  console.error('[FATAL ERROR] GOOGLE_PRIVATE_KEY 형식이 올바르지 않거나, 값이 비어있습니다.');
  process.exit(1);
}
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

console.log('[Auth] Google 인증 객체 생성을 시도합니다...');
const serviceAccountAuth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});
console.log('[Auth] Google 인증 객체 생성 완료.');

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
const drive = google.drive({ version: 'v3', auth: serviceAccountAuth });

app.use(cors());
const upload = multer({ dest: 'uploads/' });

// --- 서버 메인 로직 ---
app.post('/upload-and-email', upload.any(), async (req, res) => {
    console.log("\n///////////////////////////////////////////////////////////");
    console.log("[Request] 새로운 면접 결과 요청을 받았습니다.");

    const files = req.files;
    const participantInfo = JSON.parse(req.body.participantInfo);
    const participantName = participantInfo.name || 'UnknownParticipant';
    console.log(`[Request] 참가자 이름: ${participantName}`);
    
    const fileLinks = {};
    let isSuccess = true;

    // --- STEP 1: Google Drive ---
    try {
        console.log("\n--- STEP 1: Google Drive 파일 업로드 시작 ---");
        for (const file of files) {
            console.log(`[Drive] '${file.originalname}' 업로드 시도...`);
            const driveResponse = await drive.files.create({
                requestBody: { name: file.originalname, parents: [GOOGLE_DRIVE_FOLDER_ID] },
                media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) },
                supportsAllDrives: true, // <-- ★★★★★★★★★★★★★★★★★★★★★★★★★★★★ 이 줄이 모든 문제의 해결책입니다.
            });
            await drive.permissions.create({
                fileId: driveResponse.data.id,
                requestBody: { role: 'reader', type: 'anyone' },
                supportsAllDrives: true, // 공유 드라이브 파일 권한 설정을 위해 필요합니다.
            });
            const linkResponse = await drive.files.get({ 
                fileId: driveResponse.data.id, 
                fields: 'webViewLink',
                supportsAllDrives: true, // 공유 드라이브 파일 링크를 가져오기 위해 필요합니다.
            });
            const link = linkResponse.data.webViewLink;
            console.log(`[Drive] '${file.originalname}' 업로드 및 링크 생성 성공.`);

            let key;
            if (file.fieldname.includes('audio')) {
                const qNum = file.fieldname.split('_')[1];
                key = `Audio_${qNum.toUpperCase()}`;
            }
            else if (file.fieldname.includes('consent')) key = 'PDF_Consent';
            else if (file.fieldname.includes('survey')) key = 'PDF_Survey';
            if (key) fileLinks[key] = link;
        }
        console.log("--- STEP 1: Google Drive 파일 업로드 완료 ---\n");
    } catch (error) {
        console.error("\n[FATAL ERROR] Google Drive 처리 중 심각한 오류가 발생했습니다:", error);
        isSuccess = false;
    }

    // --- STEP 2: Google Sheets ---
    if (isSuccess) {
        try {
            console.log("--- STEP 2: Google Sheets 데이터 추가 시작 ---");
            console.log("[Sheets] 시트 정보 로딩 시도...");
            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            console.log(`[Sheets] '${sheet.title}' 시트 로딩 성공.`);
            const newRow = { ...participantInfo, ...participantInfo.surveyData, ...fileLinks };
            delete newRow.surveyData;
            
            const sheetHeaders = (sheet.headerValues || []);
            const finalRowData = {};
            sheetHeaders.forEach(header => {
                finalRowData[header] = newRow[header] !== undefined ? newRow[header] : '';
            });

            await sheet.addRow(finalRowData, { insert: true });
            console.log("[Sheets] 새로운 행 추가 성공.");
            console.log("--- STEP 2: Google Sheets 데이터 추가 완료 ---\n");
        } catch (error) {
            console.error("\n[FATAL ERROR] Google Sheets 처리 중 심각한 오류가 발생했습니다:", error);
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

