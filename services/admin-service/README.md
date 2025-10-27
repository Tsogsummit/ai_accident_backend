# AI Accident Detection - Admin Service

## Quick Setup

1. Extract this archive to your services directory
2. Install dependencies: `npm install`
3. Configure environment variables (optional)
4. Start the service: `npm start`
5. Access at http://localhost:3009

## Default Login
- Username: `admin`
- Password: `admin123`

## Important Notes
- You need to create an admin user first using POST /admin/register
- Make sure PostgreSQL and Redis are running
- Database migrations should be run before starting

## Environment Variables
```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=accident_db
DB_USER=postgres
DB_PASSWORD=postgres
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=your-secret-key
PORT=3009
```
