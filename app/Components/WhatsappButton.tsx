
'use client';
import React from 'react';
import { FaWhatsapp } from 'react-icons/fa';
const WhatsappButton = () => {
  const whatsappLink = 'https://wa.me/50589530626';
  return (
    <a
      href={whatsappLink}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-4 right-4 z-50"
    >
      <div className="bg-green-500 hover:bg-green-600 text-white p-3 rounded-full shadow-lg transition duration-300 flex items-center justify-center">
        <FaWhatsapp size={24} />
      </div>
    </a>
  );
};
export default WhatsappButton;
