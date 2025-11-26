const cameras = [];
  
  function getActiveCameras() {
    return cameras.filter(camera => camera.active);
  }
  
  function getCameraById(id) {
    return cameras.find(camera => camera.id === id);
  }
  
  function getCamerasByType(type) {
    return cameras.filter(camera => camera.type === type && camera.active);
  }
  
  module.exports = {
    cameras,
    getActiveCameras,
    getCameraById,
    getCamerasByType
  };