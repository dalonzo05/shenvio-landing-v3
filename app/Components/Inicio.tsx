
// app/Components/Inicio.tsx
'use client';
import React from 'react';
interface Props {
  id: string;
}
const Inicio: React.FC<Props> = ({ id }) => {
  return (
    <section id={id} className="relative w-full h-[85vh] overflow-hidden">
      {/* 🎥 Video de fondo */}
      <video
        className="absolute top-0 left-0 w-full h-full object-cover z-0"
        src="/motorizado.mp4"
        autoPlay
        muted
        loop
        playsInline
      />
      {/* 🧊 Capa oscura (opcional para mejorar contraste del texto) */}
      <div className="absolute top-0 left-0 w-full h-full bg-black/50 z-10" />
      {/* 📝 Contenido encima del video */}
      <div className="relative z-20 flex items-center justify-center h-full px-6">
        <div className="max-w-3xl text-center text-white">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-6 leading-tight drop-shadow-lg">
            Centraliza tus envíos con <p><span className=" text-[#ffd700]">SH Envíos</span> </p>
          </h1>
          <p className="text-lg md:text-xl mb-6 drop-shadow-md">
            Somos tu aliado logístico para entregas rápidas, confiables y con seguimiento en tiempo real.
          </p>
          <a
            href="https://wa.me/50589530626?text=Hola%2C%20me%20gustaría%20afiliarme%20a%20SH%20Envíos"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition duration-300"
          >
            Afíliate ya por WhatsApp
          </a>
        </div>
      </div>
    </section>
  );
};
export default Inicio;
