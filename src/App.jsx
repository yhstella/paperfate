import Nav from './components/Nav.jsx'
import Hero from './components/Hero.jsx'
import Simulator from './components/Simulator.jsx'
import Features from './components/Features.jsx'
import AboutFateCore from './components/AboutFateCore.jsx'
import Methods from './components/Methods.jsx'
import FAQ from './components/FAQ.jsx'
import Footer from './components/Footer.jsx'

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1">
        <Hero />
        <Simulator />
        <Features />
        <AboutFateCore />
        <Methods />
        <FAQ />
      </main>
      <Footer />
    </div>
  )
}
