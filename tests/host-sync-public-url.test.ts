import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'os'

import { getPublicUrl } from '@/lib/host-sync'

const ORIGINAL = process.env.MAESTRO_PUBLIC_URL

/** Un Pod de Kubernetes: una loopback y una eth0 con IP de Pod. */
function mockPodInterfaces() {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true } as never],
    eth0: [{ family: 'IPv4', address: '10.244.3.17', internal: false } as never],
  } as never)
}

describe('getPublicUrl', () => {
  beforeEach(() => {
    delete process.env.MAESTRO_PUBLIC_URL
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (ORIGINAL === undefined) delete process.env.MAESTRO_PUBLIC_URL
    else process.env.MAESTRO_PUBLIC_URL = ORIGINAL
  })

  describe('sin MAESTRO_PUBLIC_URL', () => {
    it('anuncia la IP del Pod, que fuera del cluster no se alcanza', () => {
      // Este es el comportamiento que motiva la variable: la deteccion por
      // interfaz no puede saber que al host se le llega por un balanceador.
      mockPodInterfaces()
      expect(getPublicUrl()).toBe('http://10.244.3.17:23000')
    })

    it('usa la url del host cuando se le pasa una', () => {
      mockPodInterfaces()
      expect(getPublicUrl({ url: 'http://10.0.16.179:23000' } as never))
        .toBe('http://10.0.16.179:23000')
    })
  })

  describe('con MAESTRO_PUBLIC_URL', () => {
    it('gana sobre la deteccion por interfaz', () => {
      mockPodInterfaces()
      process.env.MAESTRO_PUBLIC_URL = 'http://10.0.16.180:23000'
      expect(getPublicUrl()).toBe('http://10.0.16.180:23000')
    })

    it('gana tambien sobre la url del host', () => {
      // El operador sabe por donde se alcanza este host; un registro heredado
      // en hosts.json puede estar obsoleto.
      mockPodInterfaces()
      process.env.MAESTRO_PUBLIC_URL = 'http://10.0.16.180:23000'
      expect(getPublicUrl({ url: 'http://10.0.16.179:23000' } as never))
        .toBe('http://10.0.16.180:23000')
    })

    it('quita la barra final para no generar urls con doble barra', () => {
      mockPodInterfaces()
      process.env.MAESTRO_PUBLIC_URL = 'http://10.0.16.180:23000/'
      expect(getPublicUrl()).toBe('http://10.0.16.180:23000')
    })

    it('ignora el valor vacio y vuelve a la deteccion', () => {
      mockPodInterfaces()
      process.env.MAESTRO_PUBLIC_URL = '   '
      expect(getPublicUrl()).toBe('http://10.244.3.17:23000')
    })

    it('falla con una url malformada en vez de caer a la IP del Pod', () => {
      mockPodInterfaces()
      process.env.MAESTRO_PUBLIC_URL = '10.0.16.180:23000'
      expect(() => getPublicUrl()).toThrow(/not a valid URL/)
    })

    it('rechaza un esquema que no sea http ni https', () => {
      mockPodInterfaces()
      process.env.MAESTRO_PUBLIC_URL = 'ftp://10.0.16.180:23000'
      expect(() => getPublicUrl()).toThrow(/http or https/)
    })

    it('rechaza localhost, que ningun peer puede alcanzar', () => {
      mockPodInterfaces()
      process.env.MAESTRO_PUBLIC_URL = 'http://localhost:23000'
      expect(() => getPublicUrl()).toThrow(/other hosts can reach/)
    })
  })
})
