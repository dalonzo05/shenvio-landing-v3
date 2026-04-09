'use client';
import React from 'react';
import Header from './Components/Header';
import Inicio from './Components/Inicio';
import Estadisticas from './Components/Estadisticas';
import ServiciosYNosotros from './Components/ServiciosYNosotros';
import ComoFunciona from './Components/ComoFunciona';
import FAQ from './Components/FAQ';
import CTABanner from './Components/CTABanner';
import Contacto from './Components/Contacto';
import Footer from './Components/Footer';
import WhatsappButton from './Components/WhatsappButton';

export default function HomePage() {
  return (
    <>
      <Header />
      <main>
        <Inicio id="inicio" />
        <Estadisticas />
        <ServiciosYNosotros id="servicios" />
        <ComoFunciona id="como-funciona" />
        <FAQ />
        <CTABanner />
        <Contacto id="contacto" />
        <Footer />
        <WhatsappButton />
      </main>
    </>
  );
}
