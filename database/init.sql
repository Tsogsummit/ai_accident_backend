-- Database: accident_db - FIXED VERSION
-- Таны диплом дээрх класс диаграммаас

-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

-- Users хүснэгт
CREATE TABLE users (
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

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status) WHERE status = 'active';

-- Admins хүснэгт
CREATE TABLE admins (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(50) UNIQUE NOT NULL,
    permissions JSONB DEFAULT '[]',
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Cameras хүснэгт (Авто замын камер)
CREATE TABLE cameras (
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
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cameras_location ON cameras USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX idx_cameras_status ON cameras(status) WHERE status = 'active';

-- Camera logs хүснэгт
CREATE TABLE camera_logs (
    id SERIAL PRIMARY KEY,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE CASCADE,
    timestamp TIMESTAMP DEFAULT NOW(),
    status VARCHAR(50),
    error_message TEXT
);

CREATE INDEX idx_camera_logs_camera ON camera_logs(camera_id);
CREATE INDEX idx_camera_logs_timestamp ON camera_logs(timestamp DESC);

-- Videos хүснэгт
CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT,
    duration INTEGER, -- секундээр
    mime_type VARCHAR(50),
    status VARCHAR(20) DEFAULT 'uploading',
    error_message TEXT,
    uploaded_at TIMESTAMP DEFAULT NOW(),
    processing_started_at TIMESTAMP,
    processing_completed_at TIMESTAMP
);

CREATE INDEX idx_videos_user ON videos(user_id);
CREATE INDEX idx_videos_camera ON videos(camera_id);
CREATE INDEX idx_videos_status ON videos(status);
CREATE INDEX idx_videos_processing ON videos(status) WHERE status IN ('uploading', 'processing');

-- Locations хүснэгт
CREATE TABLE locations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_locations_coords ON locations USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX idx_locations_user_time ON locations(user_id, timestamp DESC);

-- Accident types хүснэгт
CREATE TABLE accident_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    description TEXT,
    severity VARCHAR(20) DEFAULT 'minor'
);

INSERT INTO accident_types (name, description, severity) VALUES
('Мөргөлдөөн', 'Хоёр ба түүнээс дээш тээврийн хэрэгслийн мөргөлдөөн', 'moderate'),
('Эвдрэл', 'Нэг тээврийн хэрэгслийн эвдрэл', 'minor'),
('Хүнд осол', 'Хүн амь хохирсон, гэмтсэн', 'severe'),
('Зам хаагдсан', 'Эвдрэл, осол зам хаасан', 'moderate');

-- ✅ FIXED: accident_time column ашиглаж байна
CREATE TABLE accidents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
    video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
    accident_type_id INTEGER REFERENCES accident_types(id),
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    description TEXT,
    image_url TEXT,
    severity VARCHAR(20) DEFAULT 'minor', -- minor, moderate, severe
    status VARCHAR(20) DEFAULT 'reported', -- reported, confirmed, resolved, false_alarm
    source VARCHAR(20) DEFAULT 'user', -- user, camera
    verification_count INTEGER DEFAULT 0,
    accident_time TIMESTAMP DEFAULT NOW(),  -- ✅ FIXED: renamed from timestamp
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_accidents_location ON accidents USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX idx_accidents_status ON accidents(status);
-- ✅ FIXED: Column name corrected
CREATE INDEX idx_accidents_time ON accidents(accident_time DESC);
CREATE INDEX idx_accidents_active ON accidents(accident_time DESC) WHERE status NOT IN ('resolved', 'false_alarm');
CREATE INDEX idx_accidents_source ON accidents(source);

-- AI Detections хүснэгт
CREATE TABLE ai_detections (
    id SERIAL PRIMARY KEY,
    video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
    confidence DECIMAL(5, 4), -- 0.0000 - 1.0000
    detected_objects JSONB,
    status VARCHAR(20) DEFAULT 'processing',
    processed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ai_detections_video ON ai_detections(video_id);
CREATE INDEX idx_ai_detections_confidence ON ai_detections(confidence DESC);

-- Report reasons хүснэгт
CREATE TABLE report_reasons (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT
);

INSERT INTO report_reasons (name, description) VALUES
('Шийдэгдсэн', 'Осол аль хэдийн шийдэгдсэн байна'),
('Байршил буруу', 'Байршил буруу тэмдэглэгдсэн'),
('Осол биш', 'Энэ осол биш юм'),
('Хуурамч мэдээлэл', 'Зориудаар буруу мэдээлэл өгсөн'),
('Давхардсан', 'Өмнө нь мэдээлсэн осол');

-- False reports хүснэгт
CREATE TABLE false_reports (
    id SERIAL PRIMARY KEY,
    accident_id INTEGER REFERENCES accidents(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason_id INTEGER REFERENCES report_reasons(id),
    comment TEXT,
    reported_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_false_reports_accident ON false_reports(accident_id);
CREATE INDEX idx_false_reports_user ON false_reports(user_id);

-- Notifications хүснэгт
CREATE TABLE notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    accident_id INTEGER REFERENCES accidents(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL, -- new_accident, status_update, nearby_accident
    title VARCHAR(200) NOT NULL,
    message TEXT,
    is_read BOOLEAN DEFAULT false,
    sent_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_read ON notifications(is_read);
CREATE INDEX idx_notifications_sent ON notifications(sent_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = false;

-- Notification settings хүснэгт
CREATE TABLE notification_settings (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    push_enabled BOOLEAN DEFAULT true,
    radius INTEGER DEFAULT 5000, -- метрээр, 5км
    accident_types JSONB DEFAULT '[]',
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Map markers хүснэгт
CREATE TABLE map_markers (
    id SERIAL PRIMARY KEY,
    accident_id INTEGER REFERENCES accidents(id) ON DELETE CASCADE UNIQUE,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    color VARCHAR(20) DEFAULT 'red',
    icon_type VARCHAR(50) DEFAULT 'warning',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_map_markers_coords ON map_markers USING GIST (
    ll_to_earth(latitude, longitude)
);

-- =====================================================
-- ФУНКЦҮҮД
-- =====================================================

-- 1. Хоёр цэгийн хоорондох зай тооцоолох (метрээр)
CREATE OR REPLACE FUNCTION calculate_distance(
    lat1 DECIMAL, lon1 DECIMAL,
    lat2 DECIMAL, lon2 DECIMAL
) RETURNS DECIMAL AS $$
DECLARE
    R CONSTANT DECIMAL := 6371000; -- Дэлхийн радиус метрээр
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

-- 2. Ойролцоох ослуудыг олох функц - ✅ FIXED
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
    accident_time TIMESTAMP,  -- ✅ FIXED
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
        a.accident_time,  -- ✅ FIXED
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

-- 1. Accident үүсэх үед Map marker автоматаар үүсгэх
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
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_create_map_marker
AFTER INSERT ON accidents
FOR EACH ROW
EXECUTE FUNCTION create_map_marker();

-- 2. Accident статус өөрчлөгдөхөд updated_at шинэчлэх
CREATE OR REPLACE FUNCTION update_accident_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_accident
BEFORE UPDATE ON accidents
FOR EACH ROW
EXECUTE FUNCTION update_accident_timestamp();

-- 3. User updated_at trigger
CREATE OR REPLACE FUNCTION update_user_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_user
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_user_timestamp();

-- =====================================================
-- VIEWS
-- =====================================================

-- 1. Идэвхтэй ослуудын харагдац - ✅ FIXED
CREATE OR REPLACE VIEW active_accidents AS
SELECT 
    a.id,
    a.latitude,
    a.longitude,
    a.description,
    a.severity,
    a.status,
    a.source,
    a.accident_time,  -- ✅ FIXED
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

-- 2. Камерын статистик харагдац - ✅ FIXED
CREATE OR REPLACE VIEW camera_statistics AS
SELECT 
    c.id,
    c.name,
    c.status,
    c.is_online,
    COUNT(DISTINCT a.id) as total_accidents,
    COUNT(DISTINCT CASE WHEN a.accident_time > NOW() - INTERVAL '24 hours' THEN a.id END) as accidents_24h,
    MAX(a.accident_time) as last_accident_time,  -- ✅ FIXED
    MAX(cl.timestamp) as last_log_time
FROM cameras c
LEFT JOIN accidents a ON c.id = a.camera_id
LEFT JOIN camera_logs cl ON c.id = cl.camera_id
GROUP BY c.id, c.name, c.status, c.is_online;

-- 3. Хэрэглэгчийн статистик - ✅ FIXED
CREATE OR REPLACE VIEW user_statistics AS
SELECT 
    u.id,
    u.name,
    u.phone,
    COUNT(DISTINCT a.id) as total_reports,
    COUNT(DISTINCT CASE WHEN a.status = 'confirmed' THEN a.id END) as confirmed_reports,
    COUNT(DISTINCT fr.id) as false_reports_made,
    MAX(a.accident_time) as last_report_time  -- ✅ FIXED
FROM users u
LEFT JOIN accidents a ON u.id = a.user_id
LEFT JOIN false_reports fr ON u.id = fr.user_id
GROUP BY u.id, u.name, u.phone;

-- =====================================================
-- SAMPLE DATA
-- =====================================================

-- Sample users
INSERT INTO users (phone, email, name, password_hash, role) VALUES
('+97699000001', 'user1@example.com', 'Батбаяр', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NU7zjIvFkNuK', 'user'),
('+97699000002', 'user2@example.com', 'Цэцэгмаа', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NU7zjIvFkNuK', 'user'),
('+97699000003', 'admin@example.com', 'Админ', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5NU7zjIvFkNuK', 'admin');

-- Sample cameras
INSERT INTO cameras (name, location, latitude, longitude, ip_address, stream_url, is_online) VALUES
('Энхтайваны өргөн чөлөө - Камер 1', 'Энхтайваны өргөн чөлөө, Чингэлтэй', 47.9184, 106.9177, '192.168.1.101', 'rtsp://camera1.example.com/stream', true),
('Барилгачдын талбай - Камер 2', 'Барилгачдын талбай', 47.9200, 106.9190, '192.168.1.102', 'rtsp://camera2.example.com/stream', true),
('Сөүлийн гудамж - Камер 3', 'Сөүлийн гудамж, Хан-Уул', 47.9150, 106.9160, '192.168.1.103', 'rtsp://camera3.example.com/stream', false);

-- Comments
COMMENT ON TABLE accidents IS 'Авто замын ослын үндсэн хүснэгт';
COMMENT ON TABLE cameras IS 'Авто замын камерууд';
COMMENT ON TABLE ai_detections IS 'AI-ээр илрүүлсэн үр дүн';
COMMENT ON TABLE false_reports IS 'Буруу мэдээллийн засварлалт';
COMMENT ON COLUMN accidents.accident_time IS 'Ослын болсон цаг (өмнө нь timestamp байсан)';

-- PostgreSQL-д камер нэмэх
INSERT INTO cameras (
  name,
  location,
  stream_url,
  status,
  resolution,
  fps,
  description,
  location_coordinates
) VALUES (
  'UB Traffic - Камер 32770',
  'Улаанбаатар',
  'https://stream.ubtraffic.mn/live/32770.stream_480p/playlist.m3u8',
  'active',
  '480p',
  25,
  'Улаанбаатарын авто замын камер',
  ST_SetSRID(ST_MakePoint(106.9057, 47.9184), 4326)  -- UB coordinates
);

-- ID авах (дараачийн алхамд хэрэг болно)
SELECT id, name FROM cameras WHERE name LIKE '%32770%';

-- Cameras хүснэгт (FIXED - updated_at, resolution нэмсэн)
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
    resolution VARCHAR(10) DEFAULT '480p',  -- ADDED
    fps INTEGER DEFAULT 25,                 -- ADDED
    description TEXT,                        -- ADDED
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()      -- ADDED
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cameras_location ON cameras USING GIST (
    ll_to_earth(latitude, longitude)
);
CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras(status) WHERE status = 'active';

-- UB Traffic камер нэмэх
INSERT INTO cameras (
  name, location, stream_url, status, resolution, fps, 
  description, latitude, longitude, is_online
) VALUES (
  'UB Traffic - Камер 32770',
  'Улаанбаатар',
  'https://stream.ubtraffic.mn/live/32770.stream_480p/playlist.m3u8',
  'active',
  '480p',
  25,
  'Улаанбаатарын авто замын камер',
  47.9184,
  106.9057,
  true
) ON CONFLICT DO NOTHING;