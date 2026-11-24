in vec4 v_color;

#ifdef ELEVATION_COLOR
    in float v_elevation_t;
    in float v_directional;

    uniform sampler2D u_color_ramp;
    uniform float u_elevation_min;
    uniform float u_elevation_range;
    uniform highp vec3 u_lightcolor;
    uniform lowp float u_lightintensity;
#endif

void main() {
#ifdef ELEVATION_COLOR
    // Sample base color from the elevation-to-color ramp.
    float t = clamp((v_elevation_t - u_elevation_min) / u_elevation_range, 0.0, 1.0);
    vec4 color = texture(u_color_ramp, vec2(t, 0.5));

    // Add slight ambient lighting so no extrusions are totally black
    color += vec4(0.03, 0.03, 0.03, 0.0);

    // Adjust directional factor for this fragment's color luminance
    float colorvalue = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
    float directional = mix((1.0 - u_lightintensity), max((1.0 - colorvalue + u_lightintensity), 1.0), v_directional);

    // Apply lighting with complementary-tinted lower bounds
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    fragColor.r += clamp(color.r * directional * u_lightcolor.r, mix(0.0, 0.3, 1.0 - u_lightcolor.r), 1.0);
    fragColor.g += clamp(color.g * directional * u_lightcolor.g, mix(0.0, 0.3, 1.0 - u_lightcolor.g), 1.0);
    fragColor.b += clamp(color.b * directional * u_lightcolor.b, mix(0.0, 0.3, 1.0 - u_lightcolor.b), 1.0);
    fragColor *= v_color.a;
#else
    fragColor = v_color;
#endif

    #ifdef OVERDRAW_INSPECTOR
        fragColor = vec4(1.0);
    #endif
}
