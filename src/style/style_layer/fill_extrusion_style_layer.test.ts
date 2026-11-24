import {describe, test, expect} from 'vitest';
import {FillExtrusionStyleLayer} from './fill_extrusion_style_layer.ts';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';

function createLayer(paint?: Record<string, unknown>): FillExtrusionStyleLayer {
    return new FillExtrusionStyleLayer({
        id: 'test',
        type: 'fill-extrusion',
        paint: paint ?? {}
    } as LayerSpecification, {});
}

describe('FillExtrusionStyleLayer elevation color', () => {

    test('hasElevationColor returns false for plain color', () => {
        const layer = createLayer({'fill-extrusion-color': '#ff0000'});
        expect(layer.hasElevationColor()).toBe(false);
        expect(layer.colorRamp).toBeUndefined();
    });

    test('hasElevationColor returns false for feature-property-based color', () => {
        const layer = createLayer({
            'fill-extrusion-color': ['get', 'color']
        });
        expect(layer.hasElevationColor()).toBe(false);
    });

    test('hasElevationColor returns true for interpolate with elevation', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['elevation'],
                0, ['rgba', 0, 0, 255, 1],
                100, ['rgba', 255, 0, 0, 1]
            ]
        });
        expect(layer.hasElevationColor()).toBe(true);
    });

    test('hasElevationColor returns true for step with elevation', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'step',
                ['elevation'],
                ['rgba', 0, 0, 255, 1],
                50, ['rgba', 0, 255, 0, 1],
                100, ['rgba', 255, 0, 0, 1]
            ]
        });
        expect(layer.hasElevationColor()).toBe(true);
    });

    test('elevation range is extracted from interpolate stops', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['elevation'],
                10, ['rgba', 0, 0, 255, 1],
                200, ['rgba', 255, 0, 0, 1]
            ]
        });
        expect(layer._elevationColorRange).toEqual([10, 200]);
    });

    test('elevation range is extracted from step stops', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'step',
                ['elevation'],
                ['rgba', 0, 0, 255, 1],
                50, ['rgba', 0, 255, 0, 1],
                150, ['rgba', 255, 0, 0, 1]
            ]
        });
        expect(layer._elevationColorRange).toEqual([50, 150]);
    });

    test('color ramp image is generated for elevation expressions', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['elevation'],
                0, ['rgba', 0, 0, 255, 1],
                100, ['rgba', 255, 0, 0, 1]
            ]
        });
        expect(layer.colorRamp).toBeDefined();
        expect(layer.colorRamp.width).toBe(256);
        expect(layer.colorRamp.height).toBe(1);
        expect(layer.colorRamp.data).toBeInstanceOf(Uint8Array);
        expect(layer.colorRamp.data).toHaveLength(256 * 4);
    });

    test('color ramp maps elevation 0 to first color and elevation max to last color', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['elevation'],
                0, ['rgba', 0, 0, 255, 1],
                100, ['rgba', 255, 0, 0, 1]
            ]
        });
        const data = layer.colorRamp.data;

        // First pixel should be close to blue (0,0,255)
        expect(data[0]).toBeLessThan(10);     // r ≈ 0
        expect(data[1]).toBeLessThan(10);     // g ≈ 0
        expect(data[2]).toBeGreaterThan(240); // b ≈ 255

        // Last pixel should be close to red (255,0,0)
        const lastOffset = (255) * 4;
        expect(data[lastOffset]).toBeGreaterThan(240);     // r ≈ 255
        expect(data[lastOffset + 1]).toBeLessThan(10);     // g ≈ 0
        expect(data[lastOffset + 2]).toBeLessThan(10);     // b ≈ 0
    });

    test('colorRampTexture is reset on paint property update', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['elevation'],
                0, ['rgba', 0, 0, 255, 1],
                100, ['rgba', 255, 0, 0, 1]
            ]
        });

        // Simulate a texture having been created
        layer.colorRampTexture = {} as any;
        expect(layer.colorRampTexture).toBeDefined();

        // Trigger paint property update
        layer._handleSpecialPaintPropertyUpdate('fill-extrusion-color');

        // Texture should be cleared so it gets recreated
        expect(layer.colorRampTexture).toBeNull();
    });

    test('non-color paint property update does not affect color ramp', () => {
        const layer = createLayer({
            'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['elevation'],
                0, ['rgba', 0, 0, 255, 1],
                100, ['rgba', 255, 0, 0, 1]
            ]
        });
        const originalRamp = layer.colorRamp;

        layer._handleSpecialPaintPropertyUpdate('fill-extrusion-height');

        // Color ramp should not have been regenerated
        expect(layer.colorRamp).toBe(originalRamp);
    });
});
