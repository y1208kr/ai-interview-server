/*
 * [V19 STRUCTURED-DATA] 데이터를 구조화하여 분석 가능한 형태로 저장
 * - 참가자 정보, 설문 응답, 파일 링크를 별도 필드로 구분
 * - 데이터 분석이 용이한 구조로 변경하고, 모든 텍스트 필드에 인코딩 복원을 적용합니다.
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
    console.error('[FATAL ERROR] Firebase 서비스 계정 키(.json) 형식이 올바르지 않습니다.', error);
    process.exit(1);
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

app.use(cors());
const upload = multer({ dest: 'uploads/' });

// 평균 계산 헬퍼 함수
function calculateMean(values) {
    const validValues = values.filter(v => v !== null && !isNaN(v));
    if (validValues.length === 0) return null;
    const sum = validValues.reduce((acc, val) => acc + val, 0);
    return Math.round((sum / validValues.length) * 100) / 100; // 소수점 2자리
}


// --- 서버 메인 로직 ---
app.post('/upload-and-email', upload.any(), async (req, res) => {
    console.log("\n///////////////////////////////////////////////////////////");
    console.log(`[V19-STRUCTURED] 새로운 면접 결과 요청을 받았습니다.`);

    const files = req.files;
    const timestamp = new Date().toISOString();

    // --- 1단계: 모든 텍스트 데이터 인코딩 복원 ---
    console.log('[Encoding] 텍스트 필드 인코딩 복원 시작...');
    const rawData = {};
    for (const key in req.body) {
        const value = req.body[key];
        if (typeof value === 'string') {
            const restoredValue = Buffer.from(value, 'latin1').toString('utf8');
            console.log(`[Encoding] ${key}: "${value}" → "${restoredValue}"`);
            rawData[key] = restoredValue;
        } else {
            rawData[key] = value;
        }
    }
    console.log('[Encoding] 인코딩 복원 완료.');
    
    const participantName = rawData.name || 'UnknownParticipant';
    const docId = `${timestamp}_${participantName}`;
    console.log(`[Request] 참가자: ${participantName}`);

    let isSuccess = true;
    const fileLinks = { audioFiles: {}, pdfFiles: {} };

    // --- 2단계: Firebase Storage 파일 업로드 ---
    try {
        console.log("\n--- Firebase Storage 파일 업로드 시작 ---");
        for (const file of files) {
            const originalFilename = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const destination = `results/${docId}/${originalFilename}`;
            console.log(`[Storage] '${originalFilename}' 업로드 중...`);
            
            await bucket.upload(file.path, { destination: destination, metadata: { contentType: file.mimetype } });
            
            const uploadedFile = bucket.file(destination);
            const [url] = await uploadedFile.getSignedUrl({ action: 'read', expires: '03-09-2491' });
            
            if (file.fieldname.startsWith('audio_q_')) {
                const qNum = file.fieldname.split('_')[2];
                fileLinks.audioFiles[`question_${qNum}`] = url;
            } else if (file.fieldname.includes('consent')) {
                fileLinks.pdfFiles.consent = url;
            } else if (file.fieldname.includes('survey')) {
                fileLinks.pdfFiles.survey = url;
            }
        }
        console.log("--- Firebase Storage 파일 업로드 완료 ---\n");
    } catch (error) {
        console.error("\n[ERROR] Firebase Storage 처리 중 오류:", error);
        isSuccess = false;
    }

    // --- 3단계: Firestore에 구조화된 데이터 저장 ---
    if (isSuccess) {
        try {
            console.log("--- Firestore 데이터 저장 시작 ---");

            // 참가자 정보 그룹
            const participant = {
                name: rawData.name || null, gender: rawData.gender || null, ageGroup: rawData.ageGroup || null,
                jobStatus: rawData.jobStatus || null, major: rawData.major || null, aiExperience: rawData.aiExperience || null,
                aiAttitude: rawData.aiAttitude ? parseInt(rawData.aiAttitude) : null, phone: rawData.phone || null,
                bankName: rawData.bankName || null, accountNumber: rawData.accountNumber || null
            };

            // 설문 응답 그룹
            const survey = {
                interactionalJustice: {
                    ij1: rawData.ij1 ? parseInt(rawData.ij1) : null, ij2: rawData.ij2 ? parseInt(rawData.ij2) : null,
                    ij3: rawData.ij3 ? parseInt(rawData.ij3) : null, ij4: rawData.ij4 ? parseInt(rawData.ij4) : null,
                    ij5: rawData.ij5 ? parseInt(rawData.ij5) : null, ij6: rawData.ij6 ? parseInt(rawData.ij6) : null,
                    ij7: rawData.ij7 ? parseInt(rawData.ij7) : null, ij8: rawData.ij8 ? parseInt(rawData.ij8) : null,
                    ij9: rawData.ij9 ? parseInt(rawData.ij9) : null
                },
                proceduralJustice: {
                    pj1: rawData.pj1 ? parseInt(rawData.pj1) : null, pj2: rawData.pj2 ? parseInt(rawData.pj2) : null,
                    pj3: rawData.pj3 ? parseInt(rawData.pj3) : null, pj4: rawData.pj4 ? parseInt(rawData.pj4) : null,
                    pj5: rawData.pj5 ? parseInt(rawData.pj5) : null, pj6: rawData.pj6 ? parseInt(rawData.pj6) : null,
                    pj7: rawData.pj7 ? parseInt(rawData.pj7) : null
                },
                organizationalAttractiveness: {
                    oa1: rawData.oa1 ? parseInt(rawData.oa1) : null, oa2: rawData.oa2 ? parseInt(rawData.oa2) : null,
                    oa3: rawData.oa3 ? parseInt(rawData.oa3) : null
                }
            };
            
            // 점수 계산 그룹
            const scores = {
                ij_mean: calculateMean(Object.values(survey.interactionalJustice)),
                pj_mean: calculateMean(Object.values(survey.proceduralJustice)),
                oa_mean: calculateMean(Object.values(survey.organizationalAttractiveness))
            };

            // 최종 문서 구조
            const structuredDocument = {
                participant, survey, scores, files: fileLinks,
                metadata: { documentId: docId, createdAt: admin.firestore.FieldValue.serverTimestamp(), condition: rawData.condition || 'general_ai' }
            };
            
            await db.collection('interviewResults').doc(docId).set(structuredDocument);
            console.log(`[Firestore] 구조화된 데이터 저장 완료: ${docId}`);
            console.log("--- Firestore 데이터 저장 완료 ---\n");

        } catch (error) {
            console.error("\n[ERROR] Firestore 처리 중 오류:", error);
            isSuccess = false;
        }
    }

    // --- 최종 응답 ---
    if (isSuccess) {
        res.status(200).json({ success: true, message: '성공적으로 제출되었습니다.', documentId: docId });
    } else {
        res.status(500).json({ success: false, message: '서버 처리 중 오류가 발생했습니다.' });
    }

    console.log("[System] 임시 파일 정리 중...");
    files.forEach(file => fs.unlinkSync(file.path));
    console.log("[System] 작업 완료\n");
});

app.listen(port, () => {
    console.log(`[System] 서버가 http://localhost:${port} 에서 실행 중입니다.`);
    console.log(`[System] 버전: V19-STRUCTURED`);
    if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
});

