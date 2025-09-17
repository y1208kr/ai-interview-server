/*
 * [V3] Google Sheets, Drive, Email 각 단계의 연결 상태를
 * 아주 상세하게 추적하여 어디서 멈추는지 찾는 최종 디버깅 버전입니다.
 */
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
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
    'GOOGLE_DRIVE_FOLDER_ID', 'GMAIL_USER', 'GMAIL_PASS'
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
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
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

    try {
        // --- STEP 1: Google Drive ---
        console.log("\n--- STEP 1: Google Drive 파일 업로드 시작 ---");
        const fileLinks = {};
        for (const file of files) {
            console.log(`[Drive] '${file.originalname}' 업로드 시도...`);
            const driveResponse = await drive.files.create({
                requestBody: { name: file.originalname, parents: [GOOGLE_DRIVE_FOLDER_ID] },
                media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) }
            });
            await drive.permissions.create({
                fileId: driveResponse.data.id,
                requestBody: { role: 'reader', type: 'anyone' }
            });
            const linkResponse = await drive.files.get({ fileId: driveResponse.data.id, fields: 'webViewLink' });
            const link = linkResponse.data.webViewLink;
            console.log(`[Drive] '${file.originalname}' 업로드 및 링크 생성 성공.`);

            let key;
            if (file.fieldname.includes('audio')) key = file.fieldname.split('_')[1].replace('q', 'Audio_Q');
            else if (file.fieldname.includes('consent')) key = 'PDF_Consent';
            else if (file.fieldname.includes('survey')) key = 'PDF_Survey';
            if (key) fileLinks[key] = link;
        }
        console.log("--- STEP 1: Google Drive 파일 업로드 완료 ---\n");


        // --- STEP 2: Google Sheets ---
        console.log("--- STEP 2: Google Sheets 데이터 추가 시작 ---");
        console.log("[Sheets] 시트 정보 로딩 시도...");
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        console.log(`[Sheets] '${sheet.title}' 시트 로딩 성공.`);
        const newRow = { ...participantInfo, ...participantInfo.surveyData, ...fileLinks };
        delete newRow.surveyData; // 중복 데이터 정리
        await sheet.addRow(newRow, { insert: true });
        console.log("[Sheets] 새로운 행 추가 성공.");
        console.log("--- STEP 2: Google Sheets 데이터 추가 완료 ---\n");


        // --- STEP 3: Nodemailer ---
        console.log("--- STEP 3: GMAIL 이메일 전송 시작 ---");
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
        });
        const sheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;
        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: 'y1208kr@gmail.com',
            subject: `[AI 면접 결과 제출] ${participantName}님의 응답이 도착했습니다.`,
            html: `<p>${participantName}님의 새로운 AI 면접 결과가 제출되었습니다.</p><p>아래 링크를 클릭하여 전체 결과를 확인하세요:</p><a href="${sheetUrl}" target="_blank">결과 시트 바로가기</a>`,
        };
        const info = await transporter.sendMail(mailOptions);
        console.log('[Email] 이메일 전송 성공:', info.response);
        console.log("--- STEP 3: GMAIL 이메일 전송 완료 ---\n");

        res.status(200).send('성공적으로 제출되어 연구자에게 전달되었습니다.');

    } catch (error) {
        console.error("\n[FATAL ERROR] 처리 중 심각한 오류가 발생했습니다:", error);
        res.status(500).send('서버 처리 중 오류가 발생했습니다. 로그를 확인해주세요.');
    } finally {
        console.log("[System] 임시 파일 정리 작업을 수행합니다.");
        files.forEach(file => fs.unlinkSync(file.path));
        console.log("[System] 모든 작업이 완료되었습니다.\n");
    }
});

app.listen(port, () => {
    console.log(`[System] 서버가 http://localhost:${port} 에서 실행 중입니다.`);
    if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
});

