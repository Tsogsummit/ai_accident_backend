/**
 * Camera Configuration
 * Камерын тохиргоо
 */

const cameras = [
    // Test камерууд (development)
    // {
    //   id: 1,
    //   name: 'Энхтайваны өргөн чөлөө - Камер 1',
    //   location: 'Энхтайваны өргөн чөлөө',
    //   streamUrl: 'rtsp://camera1.example.com/stream',
    //   type: 'rtsp',
    //   coordinates: {
    //     lat: 47.9184,
    //     lng: 106.9057
    //   },
    //   active: process.env.NODE_ENV === 'development',
    //   priority: 1
    // },
    // {
    //   id: 2,
    //   name: 'Барилгачдын талбай - Камер 2',
    //   location: 'Барилгачдын талбай',
    //   streamUrl: 'rtsp://camera2.example.com/stream',
    //   type: 'rtsp',
    //   coordinates: {
    //     lat: 47.9189,
    //     lng: 106.9175
    //   },
    //   active: process.env.NODE_ENV === 'development',
    //   priority: 2
    // },
    // {
    //   id: 3,
    //   name: 'Сөүлийн гудамж - Камер 3',
    //   location: 'Сөүлийн гудамж',
    //   streamUrl: 'rtsp://camera3.example.com/stream',
    //   type: 'rtsp',
    //   coordinates: {
    //     lat: 47.9201,
    //     lng: 106.9280
    //   },
    //   active: process.env.NODE_ENV === 'development',
    //   priority: 3
    // },
    
    // // ✅ UB Traffic камер (Production)
    // {
    //   id: 4,
    //   name: 'UB Traffic - Камер 32770',
    //   location: 'Улаанбаатар',
    //   streamUrl: 'https://stream.ubtraffic.mn/live/32770.stream_480p/playlist.m3u8',
    //   type: 'hls',
    //   coordinates: {
    //     lat: 47.9184,
    //     lng: 106.9057
    //   },
    //   active: true,
    //   priority: 0, // Highest priority
    //   resolution: '480p',
    //   fps: 25
    // }
  ];
  
  /**
   * Get active cameras
   */
  function getActiveCameras() {
    return cameras.filter(camera => camera.active);
  }
  
  /**
   * Get camera by ID
   */
  function getCameraById(id) {
    return cameras.find(camera => camera.id === id);
  }
  
  /**
   * Get cameras by type
   */
  function getCamerasByType(type) {
    return cameras.filter(camera => camera.type === type && camera.active);
  }
  
  module.exports = {
    cameras,
    getActiveCameras,
    getCameraById,
    getCamerasByType
  };