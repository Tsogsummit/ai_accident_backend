/**
 * Camera Configuration
 * Камерын тохиргоо
 */

const cameras = [
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
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