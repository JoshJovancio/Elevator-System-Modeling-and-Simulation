import json
import streamlit as st
import streamlit.components.v1 as components


st.set_page_config(
    page_title="Campus Elevator Simulation",
    layout="wide",
)

st.title("Campus Elevator Simulation")
st.caption(
    "A stochastic, animated model for comparing elevator dispatch strategies in an 11-floor campus building."
)


def load_js_file(filename):
    with open(filename, "r", encoding="utf-8") as source:
        return source.read()


config = {
    "strategy": "Split zone",
    "simSpeed": 3.0,
    "arrivalScale": 1.35,
    "capacityMin": 12,
    "capacityMax": 15,
    "travelTimePerFloor": 8,
    "boardingTimePerPassenger": 1.2,
    "doorTime": 5,
    "serveFloor2": False,
    "rates": {
        "morning": 5.8,
        "transition": 4.0,
        "lunch": 4.5,
        "outflow": 5.2,
        "classTime": 1.1,
    },
}

col_left, col_right = st.columns([0.72, 0.28], gap="large")

with col_right:
    st.subheader("Split Zone Scenario")
    st.markdown(
        """
        **Blue elevators** serve floors `1, 3, 4, 5, 6, 7`.

        **Red elevators** serve floors `1, 5, 8, 9, 10, 11`.
        """
    )

    st.subheader("Dynamic Zone Scenario")
    st.markdown(
        """
        **Elevator 1** serve floors `1, 2, 3, 4, 5`.

        **Elevator 2** serve floors `1, 5, 6, 7, 8`.

        **Elevator 3** serve floors `1, 5, 8, 9, 10, 11`.

        **Elevator 4** serve **all** floors.
        """
    )

    st.subheader("Metrics")
    st.markdown(
        """
        The animation reports average waiting time, maximum waiting time, passenger throughput, transfer count, queue length, and elevator utilization.
        """
    )

    st.subheader("Course Schedule")
    st.markdown(
        """
        - `07:30-09:10`
        - `09:30-12:00`
        - `13:00-15:00`
        - `15:30-17:00`
        """
    )

with col_left:
    models_source = load_js_file("models.js")
    dispatch_source = load_js_file("dispatch.js")
    simulation_source = load_js_file("simulation.js")

    html_payload = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8" />
        <script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.4/p5.min.js"></script>
        <style>
            html, body {{
                margin: 0;
                padding: 0;
                background: #f8fafc;
                color: #172033;
                font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }}

            #canvas-wrap {{
                width: 100%;
                display: flex;
                justify-content: center;
            }}

            .live-panel {{
                display: grid;
                grid-template-columns: 112px 150px 1fr 1fr 1fr 120px;
                gap: 8px;
                align-items: center;
                margin: 0 auto 10px auto;
                max-width: 980px;
                padding: 10px;
                background: #ffffff;
                border: 1px solid #dbe3ef;
                border-radius: 8px;
                box-sizing: border-box;
            }}

            .live-panel button,
            .live-panel select {{
                height: 32px;
                border: 1px solid #c8d3e3;
                border-radius: 6px;
                background: #f8fafc;
                color: #172033;
                font-weight: 600;
            }}

            .live-field {{
                display: grid;
                grid-template-columns: auto 1fr auto;
                gap: 6px;
                align-items: center;
                color: #59677f;
                font-size: 12px;
                white-space: nowrap;
            }}

            .live-field input[type="range"] {{
                width: 100%;
            }}

            .live-field.checkbox {{
                grid-template-columns: auto auto;
                justify-content: center;
            }}

            canvas {{
                border: 1px solid #dbe3ef;
                border-radius: 8px;
                box-shadow: 0 16px 36px rgba(15, 23, 42, 0.10);
            }}
        </style>
    </head>
    <body>
        <div class="live-panel">
            <button id="pauseBtn" type="button">Pause</button>
            <select id="strategyInput">
                <option>Split zone</option>
                <option>All floors</option>
                <option>Dynamic zoning</option>
            </select>
            <label class="live-field">Speed
                <input id="speedInput" type="range" min="0.5" max="12" value="3" step="0.5" />
                <span id="speedValue">3.0</span>
            </label>
            <label class="live-field">Arrivals
                <input id="arrivalInput" type="range" min="0.6" max="3.0" value="1.35" step="0.05" />
                <span id="arrivalValue">1.35</span>
            </label>
            <label class="live-field">Travel
                <input id="travelInput" type="range" min="4" max="16" value="8" step="1" />
                <span id="travelValue">8s</span>
            </label>
            <label class="live-field checkbox">
                <input id="floor2Input" type="checkbox" />
                Floor 2
            </label>
        </div>
        <div id="canvas-wrap"></div>
        <script>
            const APP_CONFIG = {json.dumps(config)};
        </script>
        <script>{models_source}</script>
        <script>{dispatch_source}</script>
        <script>{simulation_source}</script>
    </body>
    </html>
    """

    components.html(html_payload, height=830, scrolling=False)
