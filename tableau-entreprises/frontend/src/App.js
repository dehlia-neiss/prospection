import React from "react";
import MapProspect from "./MapProspect";  // Import de VOTRE composant
import "./App.css";  // Styles pour App seulement

function App() {
  return (
    <div className="App">
      <MapProspect />  {/* On affiche VOTRE composant */}
    </div>
  );
}

export default App;