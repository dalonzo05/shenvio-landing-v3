'use client';
import React from 'react';
import Header from './Components/Header';
import Inicio from './Components/Inicio';
import ServiciosYNosotros from './Components/ServiciosYNosotros';
import ComoFunciona from './Components/ComoFunciona';
import Contacto from './Components/Contacto';
import Footer from './Components/Footer';
import WhatsappButton from './Components/WhatsappButton';


export default function HomePage() {
  return (
    <>
      <Header />
      <main>
        <Inicio id="inicio" />
        <ServiciosYNosotros id="servicios" />
        <ComoFunciona id="como-funciona" />
        <Contacto id="contacto" />
        <Footer/>
        <WhatsappButton/>
      </main>
    
    </>
  );
}