import {CompoundExpression, Interpolate, Step, ZoomConstantExpression} from '@maplibre/maplibre-gl-style-spec';
import Point from '@mapbox/point-geometry';
import {type QueryIntersectsFeatureParams, StyleLayer} from '../style_layer.ts';
import {translateDistance, translate} from '../query_utils.ts';
import {FillExtrusionBucket} from '../../data/bucket/fill_extrusion_bucket.ts';
import {polygonIntersectsPolygon, polygonIntersectsMultiPolygon} from '../../util/intersection_tests.ts';
import {renderColorRamp} from '../../util/color_ramp.ts';
import {getCameraMath} from '../../camera/camera_math_factory.ts';
import properties, {type FillExtrusionLayoutPropsPossiblyEvaluated, type FillExtrusionPaintPropsPossiblyEvaluated} from './fill_extrusion_style_layer_properties.g.ts';

import type {BucketParameters} from '../../data/bucket.ts';
import type {Expression, LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {Layout, Transitionable, Transitioning, PossiblyEvaluated} from '../properties.ts';
import type {RGBAImage} from '../../util/image.ts';
import type {Texture} from '../../webgl/texture.ts';
import type {FillExtrusionLayoutProps, FillExtrusionPaintProps} from './fill_extrusion_style_layer_properties.g.ts';
import type {ProjectedCamera} from '../../camera/projected_camera.ts';
import type {UnwrappedTileID} from '../../tile/tile_id.ts';

/**
 * Recursively checks whether an expression references the elevation global.
 */
function expressionUsesElevation(expr: Expression): boolean {
    if (expr instanceof CompoundExpression && expr.name === 'elevation') {
        return true;
    }
    let found = false;
    expr.eachChild((child: Expression) => {
        found ||= expressionUsesElevation(child);
    });
    return found;
}

/**
 * Extracts the elevation stop range from an interpolate or step expression
 * whose input is the elevation global.
 */
function getElevationRange(expr: Expression): [number, number] | null {
    if ((expr instanceof Interpolate || expr instanceof Step) &&
        expr.input instanceof CompoundExpression && expr.input.name === 'elevation') {
        const labels = expr.labels;
        const start = isFinite(labels[0]) ? labels[0] : (labels.length > 1 ? labels[1] : 0);
        return [start, labels[labels.length - 1]];
    }
    let result: [number, number] | null = null;
    expr.eachChild((child: Expression) => {
        result ||= getElevationRange(child);
    });
    return result;
}

export class Point3D extends Point {
    z: number;
}

export const isFillExtrusionStyleLayer = (layer: StyleLayer): layer is FillExtrusionStyleLayer => layer.type === 'fill-extrusion';

export class FillExtrusionStyleLayer extends StyleLayer {
    _unevaluatedLayout: Layout<FillExtrusionLayoutProps>;
    layout: PossiblyEvaluated<FillExtrusionLayoutProps, FillExtrusionLayoutPropsPossiblyEvaluated>;

    _transitionablePaint: Transitionable<FillExtrusionPaintProps>;
    _transitioningPaint: Transitioning<FillExtrusionPaintProps>;
    paint: PossiblyEvaluated<FillExtrusionPaintProps, FillExtrusionPaintPropsPossiblyEvaluated>;

    colorRamp: RGBAImage;
    colorRampTexture: Texture;
    _elevationColorRange: [number, number] | null;

    constructor(layer: LayerSpecification, globalState: Record<string, any>) {
        super(layer, properties, globalState);
        this._updateColorRamp();
    }

    _handleSpecialPaintPropertyUpdate(name: string): void {
        if (name === 'fill-extrusion-color') {
            this._updateColorRamp();
        }
    }

    /**
     * Whether the fill-extrusion-color property uses the elevation expression,
     * requiring per-fragment coloring via a color ramp texture.
     */
    hasElevationColor(): boolean {
        return this._elevationColorRange !== null;
    }

    _updateColorRamp(): void {
        const rawExpression = this._transitionablePaint._values['fill-extrusion-color'].value.expression;
        const styleExpr = rawExpression instanceof ZoomConstantExpression
            ? rawExpression._styleExpression.expression
            : null;

        if (!styleExpr || !expressionUsesElevation(styleExpr)) {
            this._elevationColorRange = null;
            return;
        }

        this._elevationColorRange = getElevationRange(styleExpr) ?? [0, 1];
        const [min, max] = this._elevationColorRange;

        this.colorRamp = renderColorRamp({
            expression: rawExpression,
            evaluationKey: 'elevation',
            resolution: 256,
            clips: [{start: min, end: max}],
            image: this.colorRamp
        });
        this.colorRampTexture = null;
    }

    createBucket(parameters: BucketParameters<FillExtrusionStyleLayer>): FillExtrusionBucket {
        return new FillExtrusionBucket(parameters);
    }

    queryRadius(): number {
        return translateDistance(this.paint.get('fill-extrusion-translate'));
    }

    is3D(): boolean {
        return true;
    }

    queryIntersectsFeature({
        queryGeometry,
        feature,
        featureState,
        geometry,
        projectedCamera,
        pixelsToTileUnits,
        unwrappedTileID}: QueryIntersectsFeatureParams
    ): boolean | number {

        const translatedPolygon = translate(queryGeometry,
            this.paint.get('fill-extrusion-translate'),
            this.paint.get('fill-extrusion-translate-anchor'),
            -projectedCamera.bearingInRadians, pixelsToTileUnits);

        const height = this.paint.get('fill-extrusion-height').evaluate(feature, featureState);
        const base = this.paint.get('fill-extrusion-base').evaluate(feature, featureState);

        const projectedQueryGeometry = translatedPolygon.map(p => projectPoint(p, 0, projectedCamera, unwrappedTileID));
        const projectedBase = geometry.map(ring => ring.map(p => projectPoint(p, base, projectedCamera, unwrappedTileID)));
        const projectedTop = geometry.map(ring => ring.map(p => projectPoint(p, height, projectedCamera, unwrappedTileID)));
        return checkIntersection(projectedBase, projectedTop, projectedQueryGeometry);
    }
}

/**
 * Projects a point in tile coordinates at `elevation` to clip space, with the distance from the camera as its `z`.
 */
function projectPoint(point: Point, elevation: number, projectedCamera: ProjectedCamera, tileID: UnwrappedTileID): Point3D {
    const {point: projected, signedDistanceFromCamera} = getCameraMath(projectedCamera).projectTileCoordinates(projectedCamera, point.x, point.y, tileID, elevation);
    const result = projected as Point3D;
    result.z = signedDistanceFromCamera;
    return result;
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y;
}

export function getIntersectionDistance(projectedQueryGeometry: Point3D[], projectedFace: Point3D[]): number {

    if (projectedQueryGeometry.length === 1) {
        // For point queries calculate the z at which the point intersects the face
        // using barycentric coordinates.

        // Find the barycentric coordinates of the projected point within the first
        // triangle of the face, using only the xy plane. It doesn't matter if the
        // point is outside the first triangle because all the triangles in the face
        // are in the same plane.
        //
        // Check whether points are coincident and use other points if they are.
        let i = 0;
        const a = projectedFace[i++];
        let b;
        while (!b || a.equals(b)) {
            b = projectedFace[i++];
            if (!b) return Infinity;
        }

        // Loop until point `c` is not colinear with points `a` and `b`.
        for (; i < projectedFace.length; i++) {
            const c = projectedFace[i];

            const p = projectedQueryGeometry[0];

            const ab = b.sub(a);
            const ac = c.sub(a);
            const ap = p.sub(a);

            const dotABAB = dot(ab, ab);
            const dotABAC = dot(ab, ac);
            const dotACAC = dot(ac, ac);
            const dotAPAB = dot(ap, ab);
            const dotAPAC = dot(ap, ac);
            const denom = dotABAB * dotACAC - dotABAC * dotABAC;

            const v = (dotACAC * dotAPAB - dotABAC * dotAPAC) / denom;
            const w = (dotABAB * dotAPAC - dotABAC * dotAPAB) / denom;
            const u = 1 - v - w;

            // Use the barycentric weighting along with the original triangle z coordinates to get the point of intersection.
            const distance = a.z * u + b.z * v + c.z * w;

            if (isFinite(distance)) return distance;
        }

        return Infinity;

    } else {
        // The counts as closest is less clear when the query is a box. This
        // returns the distance to the nearest point on the face, whether it is
        // within the query or not. It could be more correct to return the
        // distance to the closest point within the query box but this would be
        // more complicated and expensive to calculate with little benefit.
        let closestDistance = Infinity;
        for (const p of projectedFace) {
            closestDistance = Math.min(closestDistance, p.z);
        }
        return closestDistance;
    }
}

function checkIntersection(projectedBase: Point3D[][], projectedTop: Point3D[][], projectedQueryGeometry: Point3D[]) {
    let closestDistance = Infinity;

    if (polygonIntersectsMultiPolygon(projectedQueryGeometry, projectedTop)) {
        closestDistance = getIntersectionDistance(projectedQueryGeometry, projectedTop[0]);
    }

    for (let r = 0; r < projectedTop.length; r++) {
        const ringTop = projectedTop[r];
        const ringBase = projectedBase[r];
        for (let p = 0; p < ringTop.length - 1; p++) {
            const topA = ringTop[p];
            const topB = ringTop[p + 1];
            const baseA = ringBase[p];
            const baseB = ringBase[p + 1];
            const face = [topA, topB, baseB, baseA, topA];
            if (polygonIntersectsPolygon(projectedQueryGeometry, face)) {
                closestDistance = Math.min(closestDistance, getIntersectionDistance(projectedQueryGeometry, face));
            }
        }
    }

    return closestDistance === Infinity ? false : closestDistance;
}
