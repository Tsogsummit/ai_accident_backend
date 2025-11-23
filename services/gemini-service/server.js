const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');

// Try to load from root .env if not found in current dir
const rootEnvPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(rootEnvPath)) {
    dotenv.config({ path: rootEnvPath });
    console.log(`✅ Loaded .env from ${rootEnvPath}`);
} else {
    dotenv.config();
    console.log('⚠️ Loaded .env from current directory (or defaults)');
}

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
app.use(express.json());

// Configure Multer for temporary storage
const upload = multer({ dest: 'uploads/' });

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper to convert file to GenerativePart
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: fs.readFileSync(path).toString("base64"),
            mimeType
        },
    };
}

app.post('/analyze', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No image provided' });
        }

        const filePath = req.file.path;
        const mimeType = req.file.mimetype;

        console.log(`🔍 Analyzing image: ${req.file.originalname} (${mimeType})`);

        // For now, if no API key, return mock response (for testing without key)
        if (!process.env.GEMINI_API_KEY) {
            console.warn('⚠️ No GEMINI_API_KEY found. Returning MOCK response.');
            // Cleanup
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return res.json({
                success: true,
                isAccident: true,
                confidence: 0.95,
                description: "Mock: Detected a car collision with visible damage.",
                type: "collision"
            });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
      Analyze this image for a car accident. 
      Return ONLY a JSON object with the following fields:
      - isAccident: boolean (true if there is a visible car accident or crash)
      - confidence: number (0.0 to 1.0)
      - description: string (brief description of what is seen)
      - type: string (e.g., "collision", "fire", "rollover", "breakdown", "none")
      
      Do not include markdown formatting like \`\`\`json. Just the raw JSON string.
    `;

        // Read file and convert to base64
        const fileBuffer = fs.readFileSync(filePath);
        const imagePart = {
            inlineData: {
                data: fileBuffer.toString("base64"),
                mimeType: mimeType
            },
        };

        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const text = response.text();

        console.log('🤖 Gemini Response:', text);

        // Parse JSON
        let analysis;
        try {
            // Clean up markdown if present
            const jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
            analysis = JSON.parse(jsonStr);
        } catch (e) {
            console.error('Failed to parse Gemini JSON:', e);
            analysis = { isAccident: false, confidence: 0, description: "Failed to parse AI response", type: "unknown" };
        }

        // Cleanup temp file
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        res.json({
            success: true,
            ...analysis
        });

    } catch (error) {
        console.error('❌ Gemini Analysis Error:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', service: 'gemini-service' });
});

app.listen(PORT, () => {
    console.log(`✨ Gemini Service running on port ${PORT}`);
});
