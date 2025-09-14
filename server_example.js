/*
 * 이 코드는 Node.js 환경에서 실행되어야 하는 서버 예시 코드입니다.
 * 이 파일을 실행하려면 Node.js를 설치하고, 터미널에서 다음 명령어를 실행해야 합니다.
 * npm install express multer nodemailer
 */

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const cors = require('cors'); // CORS 처리를 위한 라이브러리

const app = express();
const port = 3000; // 서버가 실행될 포트

// CORS 설정: 모든 도메인에서의 요청을 허용 (실제 운영 시에는 특정 도메인만 허용하도록 변경해야 함)
app.use(cors());

// 파일이 업로드될 임시 저장소 설정
const upload = multer({ dest: 'uploads/' });

// POST 요청을 처리할 API 엔드포인트 생성
// HTML의 fetch 요청 주소는 'http://localhost:3000/upload-and-email'이 됩니다.
app.post('/upload-and-email', upload.any(), (req, res) => {
    console.log('파일과 데이터를 받았습니다.');

    // req.files에 첨부파일 정보가, req.body에 JSON 문자열이 들어옵니다.
    const files = req.files;
    const participantInfo = JSON.parse(req.body.participantInfo);
    const participantName = participantInfo.name || 'UnknownParticipant';

    console.log(`참가자 이름: ${participantName}`);

    // 1. Nodemailer를 사용하여 이메일 전송 설정
    // 실제 사용 시에는 보안을 위해 환경 변수 등을 사용해야 합니다.
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
            // 여기에 실제 이메일 전송에 사용할 구글 계정 정보를 입력해야 합니다.
            // 주의: 앱 비밀번호를 사용하는 것이 안전합니다.
            user: 'YOUR_GMAIL_ADDRESS@gmail.com',
            pass: 'YOUR_GMAIL_APP_PASSWORD'
        },
    });

    // 2. 이메일 내용 구성
    const mailOptions = {
        from: 'YOUR_GMAIL_ADDRESS@gmail.com',
        to: 'y1208kr@gmail.com', // 수신자 이메일 주소
        subject: `[AI 면접 결과] ${participantName}님의 면접 결과입니다.`,
        html: `
            <h2>AI 면접 결과가 제출되었습니다.</h2>
            <p><strong>참가자:</strong> ${participantName}</p>
            <p><strong>제출 시각:</strong> ${new Date().toLocaleString('ko-KR')}</p>
            <p>첨부된 파일들을 확인해주세요.</p>
        `,
        attachments: files.map(file => ({
            filename: file.originalname, // 원래 파일 이름으로 첨부
            path: file.path, // 임시 저장된 파일의 경로
        })),
    };

    // 3. 이메일 전송
    transporter.sendMail(mailOptions, (error, info) => {
        // 전송 후 임시 파일 삭제
        files.forEach(file => {
            fs.unlink(file.path, err => {
                if (err) console.error(`임시 파일 삭제 실패: ${file.path}`, err);
            });
        });

        if (error) {
            console.error('이메일 전송 실패:', error);
            return res.status(500).send('서버에서 이메일 전송에 실패했습니다.');
        }
        
        console.log('이메일 전송 성공:', info.response);
        res.status(200).send('성공적으로 제출되어 연구자에게 전달되었습니다.');
    });
});

// 서버 실행
app.listen(port, () => {
    console.log(`서버가 http://localhost:${port} 에서 실행 중입니다.`);
    // 'uploads' 폴더가 없으면 생성
    if (!fs.existsSync('uploads')) {
        fs.mkdirSync('uploads');
    }
});
