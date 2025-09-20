/*
 * [V19 STRUCTURED-DATA] 데이터를 구조화하여 분석 가능한 형태로 저장
 * - 참가자 정보, 설문 응답, 파일 링크를 별도 필드로 구분
 * - 데이터 분석이 용이한 구조로 변경
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: 'uploads/' });

// --- 서버 메인 로직 ---
app.post('/upload-and-email', upload.any(), async (req, res) => {
    console.log("\n///////////////////////////////////////////////////////////");
    console.log(`[V19-STRUCTURED] 새로운 면접 결과 요청을 받았습니다.`);

    const files = req.files;
    const timestamp = new Date().toISOString();
    const createdAt = admin.firestore.FieldValue.serverTimestamp();

    // --- 1단계: 인코딩 복원 ---
    console.log('[Encoding] 텍스트 필드 인코딩 복원 시작...');
    const rawData = {};
    
    for (const key in req.body) {
        const value = req.body[key];
        if (typeof value === 'string') {
            try {
                console.log(`[Encoding] ${key}: "${value}" → "${restoredValue}"`);
                rawData[key] = restoredValue;
            } catch (e) {
                console.log(`[Encoding] 복원 실패 - ${key}, 원본 값 사용`);
                rawData[key] = value;
            }
        } else {
            rawData[key] = value;
        }
    }

    // --- 2단계: 데이터 구조화 ---
    // 참가자 기본 정보
    const participantInfo = {
        name: rawData.name || 'Unknown',
        gender: rawData.gender || '',
        ageGroup: rawData.ageGroup || '',
        jobStatus: rawData.jobStatus || '',
        major: rawData.major || '',
        aiExperience: rawData.aiExperience || '',
        aiAttitude: rawData.aiAttitude ? parseInt(rawData.aiAttitude) : null,
        phone: rawData.phone || '',
        bankName: rawData.bankName || '',
        accountNumber: rawData.accountNumber || ''
    };

    // 실험 조건
    const experimentInfo = {
        condition: rawData.condition || 'general_ai',
        timestamp: timestamp,
        createdAt: createdAt
    };

    // 설문 응답 구조화
    const surveyResponses = {
        // 상호작용 공정성 (Interactional Justice)
        interactionalJustice: {
            ij1_respect: rawData.ij1 ? parseInt(rawData.ij1) : null,
            ij2_courtesy: rawData.ij2 ? parseInt(rawData.ij2) : null,
            ij3_no_improper_remarks: rawData.ij3 ? parseInt(rawData.ij3) : null,
            ij4_no_bias: rawData.ij4 ? parseInt(rawData.ij4) : null,
            ij5_honest_explanation: rawData.ij5 ? parseInt(rawData.ij5) : null,
            ij6_timely_explanation: rawData.ij6 ? parseInt(rawData.ij6) : null,
            ij7_reasonable_explanation: rawData.ij7 ? parseInt(rawData.ij7) : null,
            ij8_sufficient_info: rawData.ij8 ? parseInt(rawData.ij8) : null,
            ij9_clear_evaluation: rawData.ij9 ? parseInt(rawData.ij9) : null
        },
        // 절차 공정성 (Procedural Justice)
        proceduralJustice: {
            pj1_express_views: rawData.pj1 ? parseInt(rawData.pj1) : null,
            pj2_consistent_application: rawData.pj2 ? parseInt(rawData.pj2) : null,
            pj3_no_bias_procedure: rawData.pj3 ? parseInt(rawData.pj3) : null,
            pj4_accurate_info: rawData.pj4 ? parseInt(rawData.pj4) : null,
            pj5_appeal_procedure: rawData.pj5 ? parseInt(rawData.pj5) : null,
            pj6_represent_values: rawData.pj6 ? parseInt(rawData.pj6) : null,
            pj7_ethical_standards: rawData.pj7 ? parseInt(rawData.pj7) : null
        },
        // 조직 매력도 (Organizational Attractiveness)
        organizationalAttractiveness: {
            oa1_attractive_workplace: rawData.oa1 ? parseInt(rawData.oa1) : null,
            oa2_positive_impression: rawData.oa2 ? parseInt(rawData.oa2) : null,
            oa3_overall_evaluation: rawData.oa3 ? parseInt(rawData.oa3) : null
        }
    };

    // 계산된 평균값 (분석용)
    const calculatedScores = {
        ij_mean: calculateMean(Object.values(surveyResponses.interactionalJustice)),
        pj_mean: calculateMean(Object.values(surveyResponses.proceduralJustice)),
        oa_mean: calculateMean(Object.values(surveyResponses.organizationalAttractiveness))
    };

    const participantName = participantInfo.name;
    const docId = `${timestamp}_${participantName}`;
    console.log(`[Request] 참가자: ${participantName}`);

    let isSuccess = true;
    const fileLinks = {
        audioFiles: {},
        pdfFiles: {}
    };

    // --- 3단계: Firebase Storage 파일 업로드 ---
    try {
        console.log("\n--- Firebase Storage 파일 업로드 시작 ---");
        for (const file of files) {
            // 파일명 인코딩 복원
            let originalFilename;
            try {
                originalFilename = Buffer.from(file.originalname, 'latin1').toString('utf8');
            } catch (e) {
                originalFilename = file.originalname;
            }
            
            const destination = `results/${docId}/${originalFilename}`;
            console.log(`[Storage] '${originalFilename}' 업로드 중...`);
            
            await bucket.upload(file.path, {
                destination: destination,
                metadata: { 
                    contentType: file.mimetype,
                    metadata: {
                        originalName: originalFilename,
                        participantName: participantName,
                        uploadTimestamp: timestamp
                    }
                }
            });
            
            const uploadedFile = bucket.file(destination);
            const [url] = await uploadedFile.getSignedUrl({
                action: 'read',
                expires: '03-09-2491'
            });
            
            // 파일 타입별로 구분하여 저장
            if (file.fieldname.startsWith('audio_q_')) {
                const qNum = file.fieldname.split('_')[2];
                fileLinks.audioFiles[`question_${qNum}`] = {
                    url: url,
                    filename: originalFilename,
                    uploadedAt: timestamp
                };
            } else if (file.fieldname.includes('consent')) {
                fileLinks.pdfFiles.consent = {
                    url: url,
                    filename: originalFilename,
                    uploadedAt: timestamp
                };
            } else if (file.fieldname.includes('survey')) {
                fileLinks.pdfFiles.survey = {
                    url: url,
                    filename: originalFilename,
                    uploadedAt: timestamp
                };
            }
        }
        console.log("--- Firebase Storage 파일 업로드 완료 ---\n");
    } catch (error) {
        console.error("\n[ERROR] Firebase Storage 처리 중 오류:", error);
        isSuccess = false;
    }

    // --- 4단계: Firestore에 구조화된 데이터 저장 ---
    if (isSuccess) {
        try {
            console.log("--- Firestore 데이터 저장 시작 ---");
            
            // 최종 구조화된 문서
            const structuredDocument = {
                // 메타 정보
                metadata: {
                    documentId: docId,
                    version: 'v19_structured',
                    createdAt: createdAt,
                    timestamp: timestamp
                },
                
                // 참가자 정보
                participant: participantInfo,
                
                // 실험 정보
                experiment: experimentInfo,
                
                // 설문 응답
                survey: surveyResponses,
                
                // 계산된 점수
                scores: calculatedScores,
                
                // 파일 링크
                files: fileLinks,
                
                // 원본 데이터 (백업용)
                rawData: rawData
            };
            
            // 메인 컬렉션에 저장
            await db.collection('interviewResults').doc(docId).set(structuredDocument);
            console.log(`[Firestore] 구조화된 데이터 저장 완료: ${docId}`);
            
            // 분석용 요약 데이터를 별도 컬렉션에도 저장 (선택사항)
            const summaryData = {
                participantName: participantInfo.name,
                condition: experimentInfo.condition,
                timestamp: timestamp,
                createdAt: createdAt,
                scores: calculatedScores,
                demographics: {
                    gender: participantInfo.gender,
                    ageGroup: participantInfo.ageGroup,
                    jobStatus: participantInfo.jobStatus,
                    aiExperience: participantInfo.aiExperience
                }
            };
            
            await db.collection('analysisSummary').doc(docId).set(summaryData);
            console.log(`[Firestore] 분석용 요약 데이터 저장 완료`);
            
            console.log("--- Firestore 데이터 저장 완료 ---\n");
        } catch (error) {
            console.error("\n[ERROR] Firestore 처리 중 오류:", error);
            isSuccess = false;
        }
    }

    // --- 최종 응답 ---
    if (isSuccess) {
        res.status(200).json({
            success: true,
            message: '성공적으로 제출되어 연구자에게 전달되었습니다.',
            documentId: docId
        });
    } else {
        res.status(500).json({
            success: false,
            message: '서버 처리 중 오류가 발생했습니다. 관리자에게 문의하세요.'
        });
    }

    // 임시 파일 정리
    console.log("[System] 임시 파일 정리 중...");
    files.forEach(file => {
        try {
            fs.unlinkSync(file.path);
        } catch (e) {
            console.error(`[System] 파일 삭제 실패: ${file.path}`);
        }
    });
    console.log("[System] 작업 완료\n");
});

// 평균 계산 헬퍼 함수
function calculateMean(values) {
    const validValues = values.filter(v => v !== null && !isNaN(v));
    if (validValues.length === 0) return null;
    const sum = validValues.reduce((acc, val) => acc + val, 0);
    return Math.round((sum / validValues.length) * 100) / 100; // 소수점 2자리
}

// 헬스체크 엔드포인트
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        version: 'v19-structured',
        timestamp: new Date().toISOString() 
    });
});

// 데이터 조회 엔드포인트 (분석용)
app.get('/data/summary', async (req, res) => {
    try {
        const snapshot = await db.collection('analysisSummary').get();
        const data = [];
        snapshot.forEach(doc => {
            data.push({
                id: doc.id,
                ...doc.data()
            });
        });
        res.json({ count: data.length, data: data });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`[System] 서버가 http://localhost:${port} 에서 실행 중입니다.`);
    console.log(`[System] 버전: V19-STRUCTURED`);
    console.log(`[System] 데이터 구조: 계층적/구조화된 형태`);
    if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
});

