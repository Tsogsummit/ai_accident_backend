const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');

const VIDEO_SERVICE_URL = 'http://localhost:3003';
const USER_SERVICE_URL = 'http://localhost:3001';

// Helper to generate random phone number
function generatePhone() {
    return '+976' + Math.floor(10000000 + Math.random() * 90000000);
}

async function registerUser(name) {
    const phone = generatePhone();
    const password = 'Password123';

    try {
        console.log(`Registering user ${name} with phone ${phone}...`);
        const response = await fetch(`${USER_SERVICE_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone,
                name,
                password,
                email: `test_${Date.now()}_${Math.random()}@example.com`
            })
        });

        const data = await response.json();

        if (data.success) {
            console.log(`✅ Registered ${name} (ID: ${data.user.id})`);
            return { token: data.accessToken, userId: data.user.id };
        } else {
            throw new Error(data.error || 'Registration failed');
        }
    } catch (error) {
        console.error(`❌ Failed to register ${name}:`, error.message);
        throw error;
    }
}

async function createDummyVideo(filename) {
    const filePath = path.join(__dirname, filename);
    // Create a small dummy file (1KB)
    const buffer = Buffer.alloc(1024);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function uploadVideo(token, userId, filePath, lat, lon, description) {
    const formData = new FormData();

    // Read file as blob
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'video/mp4' });

    formData.append('video', blob, path.basename(filePath));
    formData.append('userId', userId.toString());
    formData.append('latitude', lat.toString());
    formData.append('longitude', lon.toString());
    formData.append('description', description);

    try {
        console.log(`Uploading video for User ${userId} at ${lat}, ${lon}...`);
        const response = await fetch(`${VIDEO_SERVICE_URL}/upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });

        const data = await response.json();

        if (response.ok && data.success) {
            console.log(`✅ Upload Successful! Accident ID: ${data.accidentId}, Video ID: ${data.videoId}`);
            return data;
        } else {
            throw new Error(data.error || 'Upload failed');
        }
    } catch (error) {
        console.error('❌ Upload Failed:', error.message);
        throw error;
    }
}

async function runTests() {
    console.log('🚀 Starting Video Deduplication Verification...');
    const dummyVideo = 'test_video.mp4';
    let filePath;

    try {
        // 1. Setup
        const user1 = await registerUser('Video User 1');
        const user2 = await registerUser('Video User 2');
        filePath = await createDummyVideo(dummyVideo);

        // 2. Upload Video 1 (User 1)
        console.log('\n--- Test Case 1: Initial Video Upload ---');
        const res1 = await uploadVideo(
            user1.token,
            user1.userId,
            filePath,
            47.9188,
            106.9176,
            'Video Accident 1'
        );
        const accidentId1 = res1.accidentId;

        // 3. Upload Video 2 (User 2) - Nearby
        console.log('\n--- Test Case 2: Nearby Video Upload (Should Deduplicate) ---');
        const res2 = await uploadVideo(
            user2.token,
            user2.userId,
            filePath,
            47.9190, // Very close
            106.9178,
            'Video Accident 2 - Nearby'
        );
        const accidentId2 = res2.accidentId;

        // 4. Verify
        if (accidentId1 === accidentId2) {
            console.log(`\n✅ SUCCESS: Both videos linked to the SAME Accident ID: ${accidentId1}`);
        } else {
            console.error(`\n❌ FAILURE: Videos linked to DIFFERENT Accident IDs: ${accidentId1} vs ${accidentId2}`);
        }

    } catch (error) {
        console.error('\n❌ Test Suite Failed:', error);
    } finally {
        // Cleanup
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}

runTests();
