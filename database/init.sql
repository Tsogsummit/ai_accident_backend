-- Database: accident_db - IMPROVED VERSION with Admin User
-- =====================================================
-- EXTENSIONS
-- =====================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- For password hashing

-- =====================================================
-- TABLES
-- =====================================================

-- Users хүснэгт
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(20) UNIQUE,
    email VARCHAR(100) UNIQUE,
    name VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',
    role VARCHAR(20) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Admins хүснэгт
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    username VARCHAR(50) UNIQUE NOT NULL,
    permissions JSONB DEFAULT '["all"]',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admins_username ON admins(username);
CREATE INDEX IF NOT EXISTS idx_admins_user_id ON admins(user_id);

-- Cameras хүснэгт
CREATE TABLE IF NOT EXISTS cameras (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    location VARCHAR(255) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    ip_address VARCHAR(45),
    stream_url TEXT,
    status VARCHAR(20) DEFAULT 'active',
    is_online BOOLEAN DEFAULT false,
    last_active TIMESTAMP,
    resolution VARCHAR(10) DEFAULT '480p',
    fps INTEGER DEFAULT 25,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cameras_location ON cameras USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras(status) WHERE status = 'active';

-- Camera logs хүснэгт
CREATE TABLE IF NOT EXISTS camera_logs (
    id SERIAL PRIMARY KEY,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE CASCADE,
    timestamp TIMESTAMP DEFAULT NOW(),
    status VARCHAR(50),
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_camera_logs_camera ON camera_logs(camera_id);
CREATE INDEX IF NOT EXISTS idx_camera_logs_timestamp ON camera_logs(timestamp DESC);

-- Videos хүснэгт
CREATE TABLE IF NOT EXISTS videos (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT,
    duration INTEGER,
    mime_type VARCHAR(50),
    status VARCHAR(20) DEFAULT 'uploading',
    error_message TEXT,
    uploaded_at TIMESTAMP DEFAULT NOW(),
    processing_started_at TIMESTAMP,
    processing_completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_camera ON videos(camera_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);

-- Locations хүснэгт
CREATE TABLE IF NOT EXISTS locations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locations_coords ON locations USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX IF NOT EXISTS idx_locations_user_time ON locations(user_id, timestamp DESC);

-- Accident types хүснэгт
CREATE TABLE IF NOT EXISTS accident_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    description TEXT,
    severity VARCHAR(20) DEFAULT 'minor'
);

-- Accidents хүснэгт
CREATE TABLE IF NOT EXISTS accidents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
    accident_type_id INTEGER REFERENCES accident_types(id),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    description TEXT,
    image_url TEXT,
    severity VARCHAR(20) DEFAULT 'minor',
    status VARCHAR(20) DEFAULT 'reported',
    source VARCHAR(20) DEFAULT 'user',
    verification_count INTEGER DEFAULT 0,
    accident_time TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accidents_location ON accidents USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX IF NOT EXISTS idx_accidents_status ON accidents(status);
CREATE INDEX IF NOT EXISTS idx_accidents_time ON accidents(accident_time DESC);
CREATE INDEX IF NOT EXISTS idx_accidents_active ON accidents(accident_time DESC) 
    WHERE status NOT IN ('resolved', 'false_alarm');

-- AI Detections хүснэгт
CREATE TABLE IF NOT EXISTS ai_detections (
    id SERIAL PRIMARY KEY,
    video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
    confidence DECIMAL(5, 4),
    detected_objects JSONB,
    status VARCHAR(20) DEFAULT 'processing',
    processed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_detections_video ON ai_detections(video_id);
CREATE INDEX IF NOT EXISTS idx_ai_detections_confidence ON ai_detections(confidence DESC);

-- Report reasons хүснэгт
CREATE TABLE IF NOT EXISTS report_reasons (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT
);

-- False reports хүснэгт
CREATE TABLE IF NOT EXISTS false_reports (
    id SERIAL PRIMARY KEY,
    accident_id INTEGER REFERENCES accidents(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason_id INTEGER REFERENCES report_reasons(id),
    comment TEXT,
    reported_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_false_reports_accident ON false_reports(accident_id);
CREATE INDEX IF NOT EXISTS idx_false_reports_user ON false_reports(user_id);

-- Notifications хүснэгт
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    accident_id INTEGER REFERENCES accidents(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT false,
    sent_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_sent ON notifications(sent_at DESC);

-- Notification settings хүснэгт
CREATE TABLE IF NOT EXISTS notification_settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    push_enabled BOOLEAN DEFAULT true,
    radius INTEGER DEFAULT 5000,
    accident_types JSONB DEFAULT '[]',
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Map markers хүснэгт
CREATE TABLE IF NOT EXISTS map_markers (
    id SERIAL PRIMARY KEY,
    accident_id INTEGER REFERENCES accidents(id) ON DELETE CASCADE UNIQUE,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    color VARCHAR(20) DEFAULT 'red',
    icon_type VARCHAR(50) DEFAULT 'warning',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_map_markers_coords ON map_markers USING GIST (
    ll_to_earth(latitude, longitude)
);

-- =====================================================
-- FUNCTIONS
-- =====================================================

CREATE OR REPLACE FUNCTION calculate_distance(
    lat1 DECIMAL, lon1 DECIMAL,
    lat2 DECIMAL, lon2 DECIMAL
) RETURNS DECIMAL AS $$
DECLARE
    R CONSTANT DECIMAL := 6371000;
    rad_lat1 DECIMAL;
    rad_lat2 DECIMAL;
    delta_lat DECIMAL;
    delta_lon DECIMAL;
    a DECIMAL;
    c DECIMAL;
BEGIN
    rad_lat1 := radians(lat1);
    rad_lat2 := radians(lat2);
    delta_lat := radians(lat2 - lat1);
    delta_lon := radians(lon2 - lon1);
    
    a := sin(delta_lat/2) * sin(delta_lat/2) +
         cos(rad_lat1) * cos(rad_lat2) *
         sin(delta_lon/2) * sin(delta_lon/2);
    c := 2 * atan2(sqrt(a), sqrt(1-a));
    
    RETURN R * c;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION get_nearby_accidents(
    user_lat DECIMAL,
    user_lon DECIMAL,
    radius_meters INTEGER DEFAULT 5000
) RETURNS TABLE (
    id INTEGER,
    latitude DECIMAL,
    longitude DECIMAL,
    severity VARCHAR,
    status VARCHAR,
    description TEXT,
    accident_time TIMESTAMP,
    distance_meters DECIMAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.id,
        a.latitude,
        a.longitude,
        a.severity,
        a.status,
        a.description,
        a.accident_time,
        calculate_distance(user_lat, user_lon, a.latitude, a.longitude) as distance_meters
    FROM accidents a
    WHERE a.status != 'resolved'
        AND a.status != 'false_alarm'
        AND calculate_distance(user_lat, user_lon, a.latitude, a.longitude) <= radius_meters
    ORDER BY distance_meters ASC;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- TRIGGERS
-- =====================================================

CREATE OR REPLACE FUNCTION create_map_marker()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO map_markers (accident_id, latitude, longitude, color, icon_type)
    VALUES (
        NEW.id,
        NEW.latitude,
        NEW.longitude,
        CASE NEW.severity
            WHEN 'severe' THEN 'red'
            WHEN 'moderate' THEN 'orange'
            ELSE 'yellow'
        END,
        'warning'
    )
    ON CONFLICT (accident_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_create_map_marker ON accidents;
CREATE TRIGGER trigger_create_map_marker
AFTER INSERT ON accidents
FOR EACH ROW
EXECUTE FUNCTION create_map_marker();

CREATE OR REPLACE FUNCTION update_accident_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_accident ON accidents;
CREATE TRIGGER trigger_update_accident
BEFORE UPDATE ON accidents
FOR EACH ROW
EXECUTE FUNCTION update_accident_timestamp();

CREATE OR REPLACE FUNCTION update_user_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_user ON users;
CREATE TRIGGER trigger_update_user
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_user_timestamp();

-- =====================================================
-- VIEWS
-- =====================================================

CREATE OR REPLACE VIEW active_accidents AS
SELECT 
    a.id,
    a.latitude,
    a.longitude,
    a.description,
    a.severity,
    a.status,
    a.source,
    a.accident_time,
    u.name as reported_by,
    c.name as camera_name,
    COUNT(DISTINCT fr.id) as false_report_count,
    AVG(aid.confidence) as avg_ai_confidence
FROM accidents a
LEFT JOIN users u ON a.user_id = u.id
LEFT JOIN cameras c ON a.camera_id = c.id
LEFT JOIN false_reports fr ON a.id = fr.accident_id
LEFT JOIN videos v ON a.video_id = v.id
LEFT JOIN ai_detections aid ON v.id = aid.video_id
WHERE a.status IN ('reported', 'confirmed')
GROUP BY a.id, u.name, c.name;

CREATE OR REPLACE VIEW camera_statistics AS
SELECT 
    c.id,
    c.name,
    c.status,
    c.is_online,
    COUNT(DISTINCT a.id) as total_accidents,
    COUNT(DISTINCT CASE WHEN a.accident_time > NOW() - INTERVAL '24 hours' THEN a.id END) as accidents_24h,
    MAX(a.accident_time) as last_accident_time,
    MAX(cl.timestamp) as last_log_time
FROM cameras c
LEFT JOIN accidents a ON c.id = a.camera_id
LEFT JOIN camera_logs cl ON c.id = cl.camera_id
GROUP BY c.id, c.name, c.status, c.is_online;

CREATE OR REPLACE VIEW user_statistics AS
SELECT 
    u.id,
    u.name,
    u.phone,
    COUNT(DISTINCT a.id) as total_reports,
    COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) as confirmed_reports,
    COUNT(DISTINCT fr.id) as false_reports_made,
    MAX(a.accident_time) as last_report_time
FROM users u
LEFT JOIN accidents a ON u.id = a.user_id
LEFT JOIN false_reports fr ON u.id = fr.user_id
GROUP BY u.id, u.name, u.phone;

-- =====================================================
-- INITIAL DATA
-- =====================================================

-- Accident types
INSERT INTO accident_types (name, description, severity) VALUES
('Мөргөлдөөн', 'Хоёр ба түүнээс дээш тээврийн хэрэгслийн мөргөлдөөн', 'moderate'),
('Эвдрэл', 'Нэг тээврийн хэрэгслийн эвдрэл', 'minor'),
('Хүнд осол', 'Хүн амь хохирсон, гэмтсэн', 'severe'),
('Зам хаагдсан', 'Эвдрэл, осол зам хаасан', 'moderate')
ON CONFLICT DO NOTHING;

-- Report reasons
INSERT INTO report_reasons (name, description) VALUES
('Шийдэгдсэн', 'Осол аль хэдийн шийдэгдсэн байна'),
('Байршил буруу', 'Байршил буруу тэмдэглэгдсэн'),
('Осол биш', 'Энэ осол биш юм'),
('Хуурамч мэдээлэл', 'Зориудаар буруу мэдээлэл өгсөн'),
('Давхардсан', 'Өмнө нь мэдээлсэн осол')
ON CONFLICT DO NOTHING;

-- =====================================================
-- DEFAULT ADMIN USER
-- =====================================================

DO $$
DECLARE
    admin_user_id INTEGER;
    hashed_password TEXT;
BEGIN
    -- Generate bcrypt hash for 'admin123' (12 rounds)
    -- In production, use a STRONG password!
    hashed_password := crypt('admin123', gen_salt('bf', 12));
    
    -- Create admin user
    INSERT INTO users (
        phone, 
        email, 
        name, 
        password_hash, 
        role, 
        status
    )
    VALUES (
        '+97699999999',
        'admin@accident.mn',
        'System Admin',
        hashed_password,
        'admin',
        'active'
    )
    ON CONFLICT (phone) DO UPDATE 
    SET password_hash = EXCLUDED.password_hash
    RETURNING id INTO admin_user_id;
    
    -- Create admin entry
    INSERT INTO admins (
        user_id,
        username,
        permissions
    )
    VALUES (
        admin_user_id,
        'admin',
        '["all"]'::jsonb
    )
    ON CONFLICT (username) DO UPDATE
    SET user_id = EXCLUDED.user_id;
    
    RAISE NOTICE '✅ Admin user created successfully!';
    RAISE NOTICE '   Username: admin';
    RAISE NOTICE '   Password: admin123';
    RAISE NOTICE '   Phone: +97699999999';
    RAISE NOTICE '   Email: admin@accident.mn';
    RAISE NOTICE '';
    RAISE NOTICE '⚠️  IMPORTANT: Change the admin password immediately in production!';
    
END $$;

-- =====================================================
-- SAMPLE DATA (Development only)
-- =====================================================

-- Sample users (only in development)
DO $$
BEGIN
    IF current_setting('server_version_num')::integer >= 140000 THEN
        INSERT INTO users (phone, email, name, password_hash, role) VALUES
        ('+97699000001', 'user1@example.com', 'Батбаяр', crypt('password123', gen_salt('bf', 12)), 'user'),
        ('+97699000002', 'user2@example.com', 'Цэцэгмаа', crypt('password123', gen_salt('bf', 12)), 'user')
        ON CONFLICT DO NOTHING;
    END IF;
END $$;

-- Sample cameras
INSERT INTO cameras (name, location, latitude, longitude, stream_url, is_online, resolution, fps, description) VALUES
('Энхтайваны өргөн чөлөө - Камер 1', 'Энхтайваны өргөн чөлөө, Чингэлтэй', 47.9184, 106.9177, 'rtsp://camera1.example.com/stream', false, '720p', 25, 'Test камер - Development'),
('UB Traffic - Камер 32770', 'Улаанбаатар хот', 47.9184, 106.9057, 'https://stream.ubtraffic.mn/live/32770.stream_480p/playlist.m3u8', true, '480p', 25, 'UB Traffic system камер')
ON CONFLICT DO NOTHING;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE users IS 'Хэрэглэгчийн үндсэн мэдээлэл';
COMMENT ON TABLE admins IS 'Админ хэрэглэгчид';
COMMENT ON TABLE accidents IS 'Авто замын ослын мэдээлэл';
COMMENT ON TABLE cameras IS 'Авто замын камерууд';
COMMENT ON TABLE ai_detections IS 'AI-ээр илрүүлсэн үр дүн';
COMMENT ON TABLE false_reports IS 'Буруу мэдээллийн засварлалт';
COMMENT ON COLUMN accidents.accident_time IS 'Ослын болсон цаг';

-- =====================================================
-- COMPLETION MESSAGE
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '═══════════════════════════════════════════════════════════';
    RAISE NOTICE '✅ Database initialization completed successfully!';
    RAISE NOTICE '═══════════════════════════════════════════════════════════';
    RAISE NOTICE '';
    RAISE NOTICE '📊 Created tables: users, admins, cameras, accidents, videos, etc.';
    RAISE NOTICE '🔧 Created functions: calculate_distance, get_nearby_accidents';
    RAISE NOTICE '⚡ Created triggers: auto map markers, timestamps';
    RAISE NOTICE '👁️  Created views: active_accidents, camera_statistics, user_statistics';
    RAISE NOTICE '';
    RAISE NOTICE '👤 Default Admin Login:';
    RAISE NOTICE '   URL: http://localhost:3009/admin/login';
    RAISE NOTICE '   Username: admin';
    RAISE NOTICE '   Password: admin123';
    RAISE NOTICE '';
    RAISE NOTICE '⚠️  SECURITY WARNING:';
    RAISE NOTICE '   Change admin password immediately in production!';
    RAISE NOTICE '';
    RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $$;

-- Migration: Add camera recording and stream fields
-- Date: 2025-10-31

-- =====================================================
-- ADD NEW COLUMNS TO CAMERAS TABLE
-- =====================================================

-- Бичлэгийн статус
ALTER TABLE cameras 
ADD COLUMN IF NOT EXISTS is_recording BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS last_frame_time TIMESTAMP,
ADD COLUMN IF NOT EXISTS frames_captured INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_error TEXT,
ADD COLUMN IF NOT EXISTS stream_type VARCHAR(20) DEFAULT 'hls';

-- Index нэмэх
CREATE INDEX IF NOT EXISTS idx_cameras_recording ON cameras(is_recording) WHERE is_recording = true;
CREATE INDEX IF NOT EXISTS idx_cameras_last_frame ON cameras(last_frame_time DESC);

-- =====================================================
-- CAMERA FRAMES TABLE (AI боловсруулалтын frame-үүд)
-- =====================================================

CREATE TABLE IF NOT EXISTS camera_frames (
    id SERIAL PRIMARY KEY,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE CASCADE,
    frame_number INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW(),
    image_path TEXT,
    image_url TEXT,
    processed BOOLEAN DEFAULT false,
    detection_count INTEGER DEFAULT 0,
    
    CONSTRAINT unique_camera_frame UNIQUE (camera_id, frame_number, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_camera_frames_camera ON camera_frames(camera_id);
CREATE INDEX IF NOT EXISTS idx_camera_frames_processed ON camera_frames(processed) WHERE processed = false;
CREATE INDEX IF NOT EXISTS idx_camera_frames_timestamp ON camera_frames(timestamp DESC);

-- =====================================================
-- CAMERA DETECTIONS (камераас илэрсэн объектууд)
-- =====================================================

CREATE TABLE IF NOT EXISTS camera_detections (
    id SERIAL PRIMARY KEY,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE CASCADE,
    frame_id INTEGER REFERENCES camera_frames(id) ON DELETE CASCADE,
    detection_time TIMESTAMP DEFAULT NOW(),
    
    -- Detection мэдээлэл
    object_class VARCHAR(50) NOT NULL,
    confidence DECIMAL(5, 4) NOT NULL,
    bbox_x DECIMAL(8, 2),
    bbox_y DECIMAL(8, 2),
    bbox_width DECIMAL(8, 2),
    bbox_height DECIMAL(8, 2),
    
    -- Осол байж болзошгүй
    potential_accident BOOLEAN DEFAULT false,
    accident_id INTEGER REFERENCES accidents(id) ON DELETE SET NULL,
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_camera_detections_camera ON camera_detections(camera_id);
CREATE INDEX IF NOT EXISTS idx_camera_detections_time ON camera_detections(detection_time DESC);
CREATE INDEX IF NOT EXISTS idx_camera_detections_class ON camera_detections(object_class);
CREATE INDEX IF NOT EXISTS idx_camera_detections_potential ON camera_detections(potential_accident) 
    WHERE potential_accident = true;

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Камерын сүүлийн frame цагийг шинэчлэх
CREATE OR REPLACE FUNCTION update_camera_last_frame()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE cameras 
    SET last_frame_time = NOW(),
        frames_captured = frames_captured + 1
    WHERE id = NEW.camera_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_camera_frame ON camera_frames;
CREATE TRIGGER trigger_update_camera_frame
AFTER INSERT ON camera_frames
FOR EACH ROW
EXECUTE FUNCTION update_camera_last_frame();

-- =====================================================
-- VIEWS
-- =====================================================

-- Камерын бодит цагийн статистик
CREATE OR REPLACE VIEW camera_live_stats AS
SELECT 
    c.id,
    c.name,
    c.location,
    c.is_online,
    c.is_recording,
    c.last_frame_time,
    c.frames_captured,
    COUNT(DISTINCT cf.id) as total_frames,
    COUNT(DISTINCT cd.id) as total_detections,
    COUNT(DISTINCT cd.id) FILTER (WHERE cd.potential_accident = true) as potential_accidents,
    MAX(cd.detection_time) as last_detection_time,
    COUNT(DISTINCT a.id) as accidents_created
FROM cameras c
LEFT JOIN camera_frames cf ON c.id = cf.camera_id AND cf.timestamp >= NOW() - INTERVAL '1 hour'
LEFT JOIN camera_detections cd ON c.id = cd.camera_id AND cd.detection_time >= NOW() - INTERVAL '1 hour'
LEFT JOIN accidents a ON c.id = a.camera_id AND a.accident_time >= NOW() - INTERVAL '1 hour'
GROUP BY c.id, c.name, c.location, c.is_online, c.is_recording, c.last_frame_time, c.frames_captured;

-- =====================================================
-- SAMPLE DATA UPDATE
-- =====================================================

-- Одоо байгаа камеруудыг шинэчлэх
UPDATE cameras 
SET stream_type = 'hls',
    is_recording = false,
    frames_captured = 0
WHERE stream_url LIKE '%m3u8%';

UPDATE cameras 
SET stream_type = 'rtsp',
    is_recording = false,
    frames_captured = 0
WHERE stream_url LIKE 'rtsp://%';

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE camera_frames IS 'Камераас татаж авсан frame-үүд';
COMMENT ON TABLE camera_detections IS 'Камерын frame дээр илэрсэн объектууд';
COMMENT ON COLUMN cameras.is_recording IS 'Одоо бичлэг авч байгаа эсэх';
COMMENT ON COLUMN cameras.last_frame_time IS 'Сүүлийн frame-ийн цаг';
COMMENT ON COLUMN cameras.frames_captured IS 'Нийт авсан frame-үүдийн тоо';

-- =====================================================
-- COMPLETION MESSAGE
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE '✅ Camera recording fields migration completed!';
    RAISE NOTICE '📊 Added: camera_frames, camera_detections tables';
    RAISE NOTICE '🔧 Added: triggers and views for real-time stats';
END $$;

