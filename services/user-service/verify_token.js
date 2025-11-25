const jwt = require('jsonwebtoken');

// The secret that was in user-service (and now in all services)
const SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Simulate User Service generating a token
const user = {
    id: 123,
    phone: '+97699112233',
    email: 'test@example.com',
    role: 'user'
};

console.log('🔐 Using Secret:', SECRET);

const token = jwt.sign(
    {
        userId: user.id,
        phone: user.phone,
        email: user.email,
        role: user.role
    },
    SECRET,
    { expiresIn: '7d' }
);

console.log('✅ Generated Token:', token);

// Simulate Report Service verifying the token
jwt.verify(token, SECRET, (err, decoded) => {
    if (err) {
        console.error('❌ Verification FAILED:', err.message);
    } else {
        console.log('✅ Verification SUCCESS!');
        console.log('   Decoded:', decoded);
    }
});
