/*
 * Google Drive 및 Sheets 연동 과정을 추적하기 위해 상세한 로그를 추가한 버전입니다.
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

app.use(cors());
const upload = multer({ dest: 'uploads/' });

// --- Google API 설정 ---
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

const serviceAccountAuth = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});

const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
const drive = google.drive({ version: 'v3', auth: serviceAccountAuth });


// --- Google Drive 파일 업로드 헬퍼 함수 ---
async function uploadFileToDrive(file) {
    try {
        console.log(`[Drive] '${file.originalname}' 파일 업로드 시도...`);
        const response = await drive.files.create({
            requestBody: {
                name: file.originalname,
                parents: [GOOGLE_DRIVE_FOLDER_ID]
            },
            media: {
                mimeType: file.mimetype,
                body: fs.createReadStream(file.path)
            }
        });
        console.log(`[Drive] '${file.originalname}' 파일 업로드 성공. ID: ${response.data.id}`);

        await drive.permissions.create({
            fileId: response.data.id,
            requestBody: { role: 'reader', type: 'anyone' }
        });

        const result = await drive.files.get({
            fileId: response.data.id,
            fields: 'webViewLink'
        });
        console.log(`[Drive] '${file.originalname}' 파일 링크 생성 성공.`);
        return result.data.webViewLink;

    } catch (error) {
        console.error('[Drive] Google Drive 업로드 중 심각한 오류 발생:', error);
        return null;
    }
}


// --- 서버 메인 로직 ---
app.post('/upload-and-email', upload.any(), async (req, res) => {
    console.log("///////////////////////////////////////////////////////////");
    console.log("파일과 데이터를 받았습니다.");

    const files = req.files;
    const participantInfo = JSON.parse(req.body.participantInfo);
    const participantName = participantInfo.name || 'UnknownParticipant';
    console.log(`참가자 이름: ${participantName}`);

    // 1. 모든 파일을 Google Drive에 업로드하고 링크 받아오기
    const fileLinks = {};
    for (const file of files) {
        const link = await uploadFileToDrive(file);
        let key;
        if (file.fieldname.includes('audio')) {
            key = file.fieldname.split('_')[1].replace('q', 'Audio_Q');
        } else if (file.fieldname.includes('consent')) {
            key = 'PDF_Consent';
        } else if (file.fieldname.includes('survey')) {
            key = 'PDF_Survey';
        }
        if (key) {
            fileLinks[key] = link;
        }
    }
    console.log('생성된 파일 링크:', fileLinks);

    // 2. Google Sheets에 모든 데이터 추가
    try {
        console.log("[Sheets] 시트 정보 로딩 시도...");
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        console.log(`[Sheets] '${sheet.title}' 시트를 찾았습니다.`);
        const newRow = {
            Timestamp: participantInfo.timestamp,
            Name: participantInfo.name,
            Gender: participantInfo.gender,
            AgeGroup: participantInfo.ageGroup,
            JobStatus: participantInfo.jobStatus,
            Major: participantInfo.major,
            AIExperience: participantInfo.aiExperience,
            AIAttitude: participantInfo.aiAttitude,
            ...participantInfo.surveyData,
            ...fileLinks
        };
        await sheet.addRow(newRow);
        console.log('[Sheets] Google Sheets에 데이터 추가 성공');
    } catch (error) {
        console.error('[Sheets] Google Sheets 연동 중 심각한 오류 발생:', error);
    }

    // 3. 첨부파일 없이 알림 이메일만 전송
    console.log("[Email] 이메일 전송 시도...");
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
    });
    
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;
    const mailOptions = {
        from: process.env.GMAIL_USER,
        to: 'y1208kr@gmail.com',
        subject: `[AI 면접 결과 제출] ${participantName}님의 응답이 도착했습니다.`,
        html: `... (이메일 내용 생략) ...`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
        files.forEach(file => fs.unlinkSync(file.path));
        if (error) {
            console.error('이메일 전송 실패:', error);
            return res.status(500).send('서버에서 이메일 전송에 실패했습니다.');
        }
        console.log('이메일 전송 성공:', info.response);
        res.status(200).send('성공적으로 제출되어 연구자에게 전달되었습니다.');
    });
});

app.listen(port, () => {
    console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
    if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
});

